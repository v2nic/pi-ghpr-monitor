/**
 * Unit tests for the /ghpr-monitor no-args steering message feature.
 *
 * When /ghpr-monitor is invoked without arguments (or with just "on") and
 * no monitor is running, the extension sends a steering message to the agent
 * asking it to invoke the ghpr-monitor tool with the proper parameters,
 * rather than showing a usage error.
 *
 * These are white-box structural tests that verify the source code contains
 * the correct logic patterns.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("no-args steering message feature", () => {
	// ---------------------------------------------------------------
	// Structural tests: verify the no-args branch sends a steering
	// message instead of showing a usage error
	// ---------------------------------------------------------------

	it("sends a steering message via pi.sendUserMessage when no args and no monitor running", () => {
		// Extract the block that handles "on" or empty args
		const noArgsStart = src.indexOf('if (lower === "on" || raw === "")');
		expect(noArgsStart).toBeGreaterThan(-1);

		const nextBlock = src.indexOf("// Try parsing as a PR URL first", noArgsStart);
		expect(nextBlock).toBeGreaterThan(noArgsStart);

		const noArgsBlock = src.slice(noArgsStart, nextBlock);

		// Must NOT contain the old usage text when no monitor is running
		// (the "Usage:" text should only appear in the fallback error at
		//  the bottom for truly invalid input, not for empty args)
		const noMonitorBranch = noArgsBlock.slice(
			noArgsBlock.indexOf("// No args and no monitor running"),
		);

		// Must call pi.sendUserMessage with deliverAs: "steer"
		expect(noMonitorBranch).toContain("pi.sendUserMessage");
		expect(noMonitorBranch).toContain('deliverAs: "steer"');

		// Must NOT show a usage/help message in the no-monitor branch
		expect(noMonitorBranch).not.toContain("Usage:");
		expect(noMonitorBranch).not.toContain("/ghpr-monitor <PR URL>");
	});

	it("does not show usage error for empty args when no monitor is running", () => {
		const noArgsStart = src.indexOf('if (lower === "on" || raw === "")');
		const noArgsBlock = src.slice(noArgsStart, src.indexOf("// Try parsing as a PR URL first", noArgsStart));

		// The "not running" branch should NOT use ctx.ui.notify with
		// usage text — that was the old behavior
		const noMonitorBranch = noArgsBlock.slice(
			noArgsBlock.indexOf("// No args and no monitor running"),
		);
		expect(noMonitorBranch).not.toContain("ctx.ui.notify");
	});

	it("steering message mentions ghpr-monitor tool with action='start'", () => {
		const noArgsStart = src.indexOf('if (lower === "on" || raw === "")');
		const noArgsBlock = src.slice(noArgsStart, src.indexOf("// Try parsing as a PR URL first", noArgsStart));

		const noMonitorBranch = noArgsBlock.slice(
			noArgsBlock.indexOf("// No args and no monitor running"),
		);

		// The steering message should mention the tool name and action
		expect(noMonitorBranch).toContain("ghpr-monitor");
		expect(noMonitorBranch).toContain("action='start'");
		// Should mention that the agent can figure out the parameters
		expect(noMonitorBranch).toContain("url");
	});

	it("still shows status when monitor is already running and no args given", () => {
		const noArgsStart = src.indexOf('if (lower === "on" || raw === "")');
		const noArgsBlock = src.slice(noArgsStart, src.indexOf("// Try parsing as a PR URL first", noArgsStart));

		// The "already running" branch should show current status
		const runningBranch = noArgsBlock.slice(
			noArgsBlock.indexOf('if (monitorState.status === "running")'),
			noArgsBlock.indexOf("// No args and no monitor running"),
		);

		// Must use formatCurrentStatus to display status
		expect(runningBranch).toContain("formatCurrentStatus()");
		// Must use ctx.ui.notify to display to user
		expect(runningBranch).toContain("ctx.ui.notify(statusText");
	});

	it("does not send a steering message when monitor is already running", () => {
		const noArgsStart = src.indexOf('if (lower === "on" || raw === "")');
		const noArgsBlock = src.slice(noArgsStart, src.indexOf("// Try parsing as a PR URL first", noArgsStart));

		const runningBranch = noArgsBlock.slice(
			noArgsBlock.indexOf('if (monitorState.status === "running")'),
			noArgsBlock.indexOf("// No args and no monitor running"),
		);

		// The running branch should NOT send a steering message
		expect(runningBranch).not.toContain("pi.sendUserMessage");
	});

	it("command description mentions no-args capability", () => {
		// The description should indicate that args are optional
		const descLine = src.match(/description:\s*"Monitor a PR[^"]*"/);
		expect(descLine).not.toBeNull();
		expect(descLine![0]).toContain("leave blank");
	});

	it("header comment documents no-args behavior", () => {
		const headerComment = src.slice(0, src.indexOf("// -----------"));
		expect(headerComment).toContain("no args = ask agent");
	});
});

describe("no-args branch does not regress other command handlers", () => {
	it("check command still works independently", () => {
		const checkBlock = src.slice(
			src.indexOf('if (lower === "check")'),
			src.indexOf('if (lower === "on"', src.indexOf('if (lower === "check")')),
		);

		// check command should still force-notify
		expect(checkBlock).toContain("forceNotify = true");
		expect(checkBlock).toContain("ctx.ui.notify");
	});

	it("off command still works independently", () => {
		const offBlock = src.slice(
			src.indexOf('if (lower === "off"'),
			src.indexOf('if (lower === "check")'),
		);

		expect(offBlock).toContain("stopMonitor()");
		expect(offBlock).toContain("ctx.ui.notify");
	});

	it("URL/shorthand parsing is still present after no-args block", () => {
		// After the no-args block, URL parsing should still exist
		const afterNoArgs = src.slice(src.indexOf("// Try parsing as a PR URL first"));
		expect(afterNoArgs).toContain("parsePRUrl");
		expect(afterNoArgs).toContain("parsePRShorthand");
	});
});