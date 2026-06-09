/**
 * Unit tests for the /ghpr-monitor no-args behavior.
 *
 * When /ghpr-monitor is invoked without arguments (or with just "on") and
 * no monitor is running, the extension shows a usage hint via ctx.ui.notify()
 * only — without sending a steering message or triggering an agent turn.
 *
 * When monitors are already running, it shows the current status.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("no-args behavior without steer message", () => {
	it("shows usage via ctx.ui.notify when no args and no monitor running", () => {
		// Find the block that handles "on" or empty args
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		// The "no monitors running" branch should use ctx.ui.notify, NOT pi.sendUserMessage
		const onBlock = src.slice(onBlockStart, onBlockStart + 800);

		// Must NOT send a steering message
		expect(onBlock).not.toContain("pi.sendUserMessage");

		// Must use ctx.ui.notify for UI-only display
		expect(onBlock).toContain("ctx.ui.notify");
	});

	it("does not send a steering message mentioning action='start'", () => {
		// The old steer message text should not be present
		const steerIdx = src.indexOf("The user wants to start PR monitoring");
		expect(steerIdx).toBe(-1);
	});

	it("shows status when monitors are already running and no args given", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		// The "already monitoring" branch must show current status
		const runningBranch = src.slice(
			src.indexOf("if (monitors.size > 0)", onBlockStart),
			src.indexOf("// No monitors running", onBlockStart),
		);
		expect(runningBranch).toContain("formatCurrentStatus()");
		expect(runningBranch).toContain("ctx.ui.notify(statusText");
	});

	it("shows a usage hint when no monitor is running (not an error)", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		// After "No monitors running", there should be a ctx.ui.notify with usage info
		const noMonitorsBranch = src.slice(onBlockStart, onBlockStart + 1200);
		expect(noMonitorsBranch).toContain("No PR monitors running");
		expect(noMonitorsBranch).toContain("ctx.ui.notify");
		// Should NOT be an error or warning — just info
		expect(noMonitorsBranch).toContain('"info"');
	});

	it("command description mentions status/usage capability", () => {
		const descMatch = src.match(/description:\s*"Monitor[^"]*"/);
		expect(descMatch).not.toBeNull();
		expect(descMatch![0]).toContain("status/usage");
	});

	it("header comment documents no-args behavior", () => {
		const headerComment = src.slice(0, src.indexOf("// -----------") > 0 ? src.indexOf("// -----------") : 2000);
		expect(headerComment).toContain("no args = show status/usage");
	});
});

describe("no-args branch does not regress other command handlers", () => {
	it("check command still works with per-monitor forceNotify", () => {
		expect(src).toContain("mon.forceNotify = true");
		expect(src).toContain("ctx.ui.notify");
	});

	it("off command still works with stopAllMonitors and stopMonitorByKey", () => {
		expect(src).toContain("stopAllMonitors()");
		expect(src).toContain("stopMonitorByKey");
	});

	it("URL/shorthand parsing is still present after no-args block", () => {
		const afterNoArgs = src.slice(src.indexOf("// Try parsing as a PR URL first"));
		expect(afterNoArgs).toContain("parsePRUrl");
		expect(afterNoArgs).toContain("parsePRShorthand");
	});
});