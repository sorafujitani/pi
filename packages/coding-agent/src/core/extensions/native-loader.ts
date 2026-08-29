/**
 * Native ESM loading for extensions in the bundled Node distribution.
 *
 * jiti loads every extension module through its own resolver and a vm-compiled
 * CJS wrapper, costing ~2-3ms per module and hiding the code from V8's compile
 * cache. Module customization hooks let Node import extensions natively
 * instead: bare imports of bundled pi packages resolve to the bundle's own
 * entry files (sharing live module instances with the runtime), TypeScript
 * installed under node_modules is fed through Node's built-in type stripping,
 * and the compile cache applies to every extension module.
 *
 * The loader activates only when the bundle ships a virtual-modules.json
 * manifest next to this chunk; every failure falls back to jiti.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "../../config.ts";

/**
 * Query parameter that busts Node's module registry when extensions are
 * reloaded. jiti re-evaluates modules on every import; the native registry
 * caches forever, so reloads need fresh URLs.
 */
const GENERATION_PARAM = "pi-extension-generation";

/** Specifier -> resolved URL of the bundle entry. null = unavailable. */
let virtualModuleUrls: Map<string, string> | null | undefined;

function ensureHooksRegistered(): boolean {
	if (virtualModuleUrls !== undefined) return virtualModuleUrls !== null;
	virtualModuleUrls = null;
	if (typeof nodeModule.registerHooks !== "function") return false;

	let manifest: Record<string, string>;
	try {
		manifest = JSON.parse(fs.readFileSync(new URL("./virtual-modules.json", import.meta.url), "utf8"));
	} catch {
		// Not running from a bundle that ships the manifest.
		return false;
	}
	const urls = new Map<string, string>();
	for (const [specifier, relativePath] of Object.entries(manifest)) {
		urls.set(specifier, new URL(relativePath, import.meta.url).href);
	}

	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			const mapped = urls.get(specifier);
			if (mapped) return { url: mapped, shortCircuit: true };
			let resolved: nodeModule.ResolveFnOutput | undefined;
			try {
				resolved = nextResolve(specifier, context);
			} catch (error) {
				// TypeScript-authored extensions use specifiers jiti accepted but
				// the native resolver rejects: ".js" suffixes that map to ".ts"
				// files on disk (NodeNext style) and extensionless or directory
				// relative imports.
				if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw error;
				const candidates = specifier.endsWith(".js")
					? [`${specifier.slice(0, -3)}.ts`]
					: specifier.endsWith(".mjs")
						? [`${specifier.slice(0, -4)}.mts`]
						: [`${specifier}.ts`, `${specifier}.js`, `${specifier}/index.ts`, `${specifier}/index.js`];
				for (const candidate of candidates) {
					try {
						resolved = nextResolve(candidate, context);
						break;
					} catch {}
				}
				if (!resolved) throw error;
			}
			// Keep every local file of a reloaded extension on the reload's
			// cache-busting query so edits to non-entry files are picked up too.
			// node_modules dependencies stay cached: they do not change while a
			// session is running, and fresh query URLs would re-evaluate them on
			// every reload.
			if (context.parentURL?.includes(GENERATION_PARAM)) {
				const generation = new URL(context.parentURL).searchParams.get(GENERATION_PARAM);
				if (
					generation !== null &&
					resolved.url.startsWith("file:") &&
					!resolved.url.includes("/node_modules/") &&
					!resolved.url.includes("?")
				) {
					resolved = { ...resolved, url: `${resolved.url}?${GENERATION_PARAM}=${generation}` };
				}
			}
			// jiti tolerated JSON imports without attributes; the native loader
			// requires `with { type: "json" }`. Supply the attribute instead of
			// failing extensions that import their package.json.
			if (new URL(resolved.url).pathname.endsWith(".json") && context.importAttributes?.type === undefined) {
				resolved = { ...resolved, importAttributes: { ...context.importAttributes, type: "json" } };
			}
			return resolved;
		},
		load(url, context, nextLoad) {
			// Node refuses to type-strip TypeScript under node_modules (where
			// npm-installed extensions live), and the refusal happens in the
			// module translator, after load hooks run, so it cannot be caught
			// here. Strip every extension .ts explicitly instead: "transform"
			// mode also covers enums and namespaces, and the on-disk cache keeps
			// warm starts from loading the SWC wasm transpiler at all.
			const pathname = new URL(url).pathname;
			if (
				(pathname.endsWith(".ts") || pathname.endsWith(".mts")) &&
				typeof nodeModule.stripTypeScriptTypes === "function"
			) {
				const fileUrl = new URL(url);
				fileUrl.search = "";
				const typescriptSource = fs.readFileSync(fileUrl, "utf8");
				const cacheKey = crypto
					.createHash("sha256")
					.update(`${process.version}\0${pathname}\0`)
					.update(typescriptSource)
					.digest("hex");
				const cachePath = path.join(getAgentDir(), "cache", "native-ts", `${cacheKey}.mjs`);
				let source: string;
				try {
					source = fs.readFileSync(cachePath, "utf8");
				} catch {
					source = nodeModule.stripTypeScriptTypes(typescriptSource, {
						mode: "transform",
						sourceMap: true,
						sourceUrl: url,
					});
					try {
						fs.mkdirSync(path.dirname(cachePath), { recursive: true });
						// Concurrent pi processes may strip the same file; write via
						// rename so readers never observe a partial entry.
						const tempPath = `${cachePath}.${process.pid}.tmp`;
						fs.writeFileSync(tempPath, source);
						fs.renameSync(tempPath, cachePath);
					} catch {
						// Caching is best-effort; the stripped source is still valid.
					}
				}
				return { format: "module", source, shortCircuit: true };
			}
			return nextLoad(url, context);
		},
	});
	virtualModuleUrls = urls;
	return true;
}

/**
 * Import an extension module through Node's own loader. Returns undefined when
 * native loading is unavailable or the import fails; callers fall back to
 * jiti, which reproduces genuine extension errors (at the cost of re-running
 * any top-level side effects that executed before a native failure).
 */
export async function tryImportExtensionNatively(extensionPath: string, generation: number): Promise<unknown> {
	if (!ensureHooksRegistered()) return undefined;
	const url = pathToFileURL(extensionPath);
	if (generation > 0) url.searchParams.set(GENERATION_PARAM, String(generation));
	try {
		// Dynamic import is the point: the specifier is a user-installed
		// extension path known only at runtime.
		return await import(url.href);
	} catch {
		return undefined;
	}
}
