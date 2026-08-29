import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type * as Undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const require = createRequire(import.meta.url);
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let lazyGlobalFetch: typeof globalThis.fetch | undefined;
let pendingTimeoutMs: number | undefined;
let undiciModule: typeof Undici | undefined;

// undici is ~700KB of JavaScript that no startup path needs before the first
// request, so it is loaded on the first fetch rather than at import time.
function loadUndici(): typeof Undici {
	undiciModule ??= require("undici") as typeof Undici;
	return undiciModule;
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends Undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): Undici.Dispatcher {
	const undici = loadUndici();
	return withUndiciErrorListener(new undici.Client(origin, options as Undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): Undici.Dispatcher {
	const undici = loadUndici();
	const dispatcherOptions = options as Undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

function isPiManagedFetch(fetchImpl: typeof globalThis.fetch): boolean {
	return fetchImpl === originalGlobalFetch || fetchImpl === installedGlobalFetch || fetchImpl === lazyGlobalFetch;
}

function applyHttpDispatcher(timeoutMs: number): void {
	const undici = loadUndici();
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: timeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: timeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	if (isPiManagedFetch(globalThis.fetch)) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
		if (installedGlobalFetch === lazyGlobalFetch) {
			installedGlobalFetch = originalGlobalFetch;
			globalThis.fetch = originalGlobalFetch;
		}
	}
	pendingTimeoutMs = undefined;
}

/**
 * Loads undici and applies the configured dispatcher now instead of on the first fetch.
 */
export function loadHttpDispatcher(): void {
	if (pendingTimeoutMs !== undefined) {
		applyHttpDispatcher(pendingTimeoutMs);
	}
}

function installLazyGlobalFetch(): void {
	if (globalThis.fetch === lazyGlobalFetch) {
		return;
	}
	lazyGlobalFetch = (input, init) => {
		loadHttpDispatcher();
		return globalThis.fetch(input, init);
	};
	globalThis.fetch = lazyGlobalFetch;
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	pendingTimeoutMs = normalizedTimeoutMs;
	// A host that replaced fetch never routes through the lazy wrapper, so the
	// dispatcher has to be installed immediately for its requests to see it.
	if (undiciModule !== undefined || !isPiManagedFetch(globalThis.fetch)) {
		applyHttpDispatcher(normalizedTimeoutMs);
		return;
	}
	installLazyGlobalFetch();
}
