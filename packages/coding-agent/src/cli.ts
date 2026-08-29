#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { enableCompileCache } from "node:module";
import { APP_NAME, VERSION } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
	console.log(VERSION);
	process.exit(0);
}

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

// main.ts pulls in the whole runtime. Importing it after enabling the compile
// cache lets Node reuse its bytecode on subsequent starts.
try {
	enableCompileCache?.();
} catch {}
const { main } = await import("./main.ts");
main(args);
