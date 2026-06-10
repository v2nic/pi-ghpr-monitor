/**
 * Unit tests for the start prompt injection feature.
 *
 * When the user invokes /ghpr-monitor ! or /ghpr-monitor start, the extension:
 * 1. Auto-detects the PR for the current git branch
 * 2. Starts monitoring that PR
 * 3. Injects a steering prompt via pi.sendUserMessage() so the LLM sees
 *    the user requested monitoring and will actively respond to notifications.
 *
 * When monitoring is started with an explicit PR URL or shorthand,
 * NO steer prompt is injected — only a TUI notification confirms the
 * monitor started. This is intentional: explicit URLs are TUI-only, while
 * the !/start subcommands trigger an LLM turn.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("start prompt injection on !/start subcommands", () => {
	it("defines a sendStartPrompt helper function", () => {
		expect(src).toContain("function sendStartPrompt(config: MonitorConfig)");
	});

	it("sendStartPrompt uses pi.sendUserMessage with deliverAs steer", () => {
		const fnStart = src.indexOf("function sendStartPrompt(config: MonitorConfig)");
		expect(fnStart).toBeGreaterThan(-1);
		// Find the closing brace of the function (may have nested braces)
		let depth = 0;
		let fnBodyEnd = fnStart;
		for (let i = fnStart; i < src.length; i++) {
			if (src[i] === "{") depth++;
			if (src[i] === "}") {
				depth--;
				if (depth === 0) {
					fnBodyEnd = i;
					break;
				}
			}
		}
		const fnBody = src.slice(fnStart, fnBodyEnd + 1);
		expect(fnBody).toContain("pi.sendUserMessage");
		expect(fnBody).toContain('deliverAs: "steer"');
	});

	it("sendStartPrompt includes the PR URL in the prompt text", () => {
		const fnStart = src.indexOf("function sendStartPrompt(config: MonitorConfig)");
		expect(fnStart).toBeGreaterThan(-1);
		let depth = 0;
		let fnBodyEnd = fnStart;
		for (let i = fnStart; i < src.length; i++) {
			if (src[i] === "{") depth++;
			if (src[i] === "}") {
				depth--;
				if (depth === 0) {
					fnBodyEnd = i;
					break;
				}
			}
		}
		const fnBody = src.slice(fnStart, fnBodyEnd + 1);
		expect(fnBody).toContain("prUrl");
		expect(fnBody).toContain("prLabel");
	});

	it("sendStartPrompt instructs the LLM to watch for updates and take action", () => {
		const fnStart = src.indexOf("function sendStartPrompt(config: MonitorConfig)");
		expect(fnStart).toBeGreaterThan(-1);
		let depth = 0;
		let fnBodyEnd = fnStart;
		for (let i = fnStart; i < src.length; i++) {
			if (src[i] === "{") depth++;
			if (src[i] === "}") {
				depth--;
				if (depth === 0) {
					fnBodyEnd = i;
					break;
				}
			}
		}
		const fnBody = src.slice(fnStart, fnBodyEnd + 1);
		expect(fnBody).toMatch(/Watch for PR status updates/);
		expect(fnBody).toMatch(/take action/);
	});

	it("sendStartPrompt is called in the !/start command handler", () => {
		// The !/start command handler should call sendStartPrompt when
		// monitoring starts successfully
		const startHandlerIdx = src.indexOf('raw === "!" || raw.toLowerCase() === "start"');
		expect(startHandlerIdx).toBeGreaterThan(-1);

		// Find the end of the !/start handler block (before the next major section)
		const nextSectionIdx = src.indexOf("// Parse: status", startHandlerIdx);
		expect(nextSectionIdx).toBeGreaterThan(-1);

		const handlerBlock = src.slice(startHandlerIdx, nextSectionIdx);
		expect(handlerBlock).toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is NOT called in the explicit PR URL handler", () => {
		// Explicit PR URLs should only show TUI notification, no steer prompt
		const urlHandlerIdx = src.indexOf("// Try parsing as a PR URL first");
		expect(urlHandlerIdx).toBeGreaterThan(-1);
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Try parsing as \"owner/repo#number\""));
		expect(urlBlock).not.toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is NOT called in the shorthand handler", () => {
		const shorthandIdx = src.indexOf("parsePRShorthand(raw)");
		expect(shorthandIdx).toBeGreaterThan(-1);
		const shorthandBlock = src.slice(shorthandIdx, src.indexOf("// Try parsing as \"owner/repo number"));
		expect(shorthandBlock).not.toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is NOT called in the owner/repo number handler", () => {
		const ownerRepoIdx = src.indexOf("// Try parsing as \"owner/repo number [message]\"");
		expect(ownerRepoIdx).toBeGreaterThan(-1);
		const usageIdx = src.indexOf("Usage:", ownerRepoIdx);
		expect(usageIdx).toBeGreaterThan(-1);
		const ownerRepoBlock = src.slice(ownerRepoIdx, usageIdx);
		expect(ownerRepoBlock).not.toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is NOT called in the tool action=start handler", () => {
		// The tool is called by the LLM itself, so no extra steer prompt needed
		const toolStartIdx = src.indexOf('case "start": {');
		expect(toolStartIdx).toBeGreaterThan(-1);
		const toolStartBlock = src.slice(toolStartIdx, src.indexOf('case "status": {'));
		expect(toolStartBlock).not.toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is only sent when not already monitoring", () => {
		// In the !/start handler, sendStartPrompt is inside the else branch
		const startHandlerIdx = src.indexOf('raw === "!" || raw.toLowerCase() === "start"');
		expect(startHandlerIdx).toBeGreaterThan(-1);
		const nextSectionIdx = src.indexOf("// Parse: status", startHandlerIdx);
		const handlerBlock = src.slice(startHandlerIdx, nextSectionIdx);

		// sendStartPrompt should be inside an else block (not already monitoring)
		const sendStartIdx = handlerBlock.indexOf("sendStartPrompt(config)");
		expect(sendStartIdx).toBeGreaterThan(-1);

		// Find the "else" branch that contains sendStartPrompt
		const beforeSendStart = handlerBlock.slice(Math.max(0, sendStartIdx - 200), sendStartIdx);
		expect(beforeSendStart).toContain("else");
	});

	it("sendStartPrompt respects NO_AGENT mode", () => {
		const fnStart = src.indexOf("function sendStartPrompt(config: MonitorConfig)");
		expect(fnStart).toBeGreaterThan(-1);
		let depth = 0;
		let fnBodyEnd = fnStart;
		for (let i = fnStart; i < src.length; i++) {
			if (src[i] === "{") depth++;
			if (src[i] === "}") {
				depth--;
				if (depth === 0) {
					fnBodyEnd = i;
					break;
				}
			}
		}
		const fnBody = src.slice(fnStart, fnBodyEnd + 1);
		expect(fnBody).toContain("NO_AGENT");
	});
});

describe("!/start subcommand auto-detects current PR", () => {
	it("defines detectCurrentPR function that uses gh pr view", () => {
		expect(src).toContain("async function detectCurrentPR()");
		expect(src).toContain("gh pr view");
	});

	it("! and start subcommands are handled in the command handler", () => {
		expect(src).toContain('raw === "!" || raw.toLowerCase() === "start"');
	});

	it("! and start subcommand completions are provided", () => {
		const completionsIdx = src.indexOf("getArgumentCompletions");
		expect(completionsIdx).toBeGreaterThan(-1);
		const completionsBlock = src.slice(completionsIdx, completionsIdx + 400);
		expect(completionsBlock).toContain('"!"');
		expect(completionsBlock).toContain('"start"');
	});

	it("detectCurrentPR returns ParsedPR or null", () => {
		expect(src).toContain("): Promise<ParsedPR | null>");
		expect(src).toContain("parsePRUrl(data.url)");
	});

	it("no-PR error message suggests creating a PR", () => {
		expect(src).toContain("No PR found for the current branch");
	});

	it("usage message mentions !/start subcommand", () => {
		const usageIdx = src.indexOf("Usage:");
		expect(usageIdx).toBeGreaterThan(-1);
		const usageBlock = src.slice(usageIdx, usageIdx + 400);
		expect(usageBlock).toContain("/ghpr-monitor !");
		expect(usageBlock).toContain("start");
	});
});

describe("explicit PR URL does not trigger LLM turn", () => {
	it("PR URL handler uses ctx.ui.notify for success, not pi.sendUserMessage", () => {
		const urlHandlerIdx = src.indexOf("// Try parsing as a PR URL first");
		expect(urlHandlerIdx).toBeGreaterThan(-1);
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Try parsing as \"owner/repo#number\""));

		// Success notification should use ctx.ui.notify (TUI-only)
		expect(urlBlock).toContain("ctx.ui.notify(result.message, \"success\")");
		// Should NOT contain sendStartPrompt (which triggers LLM turn)
		expect(urlBlock).not.toContain("sendStartPrompt");
	});

	it("shorthand handler uses ctx.ui.notify for success, not pi.sendUserMessage", () => {
		const shorthandIdx = src.indexOf("parsePRShorthand(raw)");
		expect(shorthandIdx).toBeGreaterThan(-1);
		const shorthandBlock = src.slice(shorthandIdx, src.indexOf("// Try parsing as \"owner/repo number"));
		expect(shorthandBlock).toContain("ctx.ui.notify(result.message, \"success\")");
		expect(shorthandBlock).not.toContain("sendStartPrompt");
	});
});