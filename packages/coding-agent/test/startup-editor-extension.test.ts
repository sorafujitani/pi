import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { EditorFactory } from "../src/core/extensions/types.ts";

describe("startup editor extension registration", () => {
	it("stores the editor factory without firing session lifecycle events", async () => {
		const factory = (() => {
			throw new Error("factory should only be invoked by the TUI");
		}) as EditorFactory;
		let sessionStartCalls = 0;

		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerStartupEditor(factory);
				pi.on("session_start", () => {
					sessionStartCalls += 1;
				});
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(extension.startupEditorFactory).toBe(factory);
		expect(sessionStartCalls).toBe(0);
	});
});
