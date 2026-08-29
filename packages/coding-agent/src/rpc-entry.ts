#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";

process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

try {
	enableCompileCache?.();
} catch {}
const { main } = await import("./main.ts");
main(["--mode", "rpc", ...process.argv.slice(2)]);
