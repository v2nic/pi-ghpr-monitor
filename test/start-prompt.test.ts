/**
 * Unit tests for the start prompt injection feature.
 *
 * When monitoring is started (via /ghpr-monitor command or ghpr-monitor tool
 * with action="start"), a steering prompt is sent via pi.sendUserMessage()
 * so the LLM sees that the user requested monitoring this PR and will
 * actively respond to notifications.
 *
 * The start prompt is only sent when a new monitor is actually started
 * (not when already monitoring), and is sent in addition to any user-provided
 * steer message.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("start prompt injection on monitor start", () => {
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

	it("sendStartPrompt is called in the tool action=start handler", () => {
		const toolStartIdx = src.indexOf('case "start": {');
		expect(toolStartIdx).toBeGreaterThan(-1);
		const toolStartBlock = src.slice(toolStartIdx, src.indexOf('case "status": {'));
		expect(toolStartBlock).toContain("sendStartPrompt(config)");
		expect(toolStartBlock).toContain("!result.alreadyMonitoring");
	});

	it("sendStartPrompt is called in the command PR URL handler", () => {
		// The command handler for PR URLs
		const urlHandlerIdx = src.indexOf("// Try parsing as a PR URL first");
		expect(urlHandlerIdx).toBeGreaterThan(-1);
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Try parsing as \"owner/repo#number\""));
		expect(urlBlock).toContain("sendStartPrompt(config)");
		// Should only send when NOT already monitoring
		expect(urlBlock).toContain("else");
		expect(urlBlock).toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is called in the command shorthand handler", () => {
		const shorthandIdx = src.indexOf("parsePRShorthand(raw)");
		expect(shorthandIdx).toBeGreaterThan(-1);
		// Find the shorthand block
		const shorthandBlock = src.slice(shorthandIdx, src.indexOf("// Try parsing as \"owner/repo number"));
		expect(shorthandBlock).toContain("sendStartPrompt(config)");
	});

	it("sendStartPrompt is called in the command owner/repo number handler", () => {
		const ownerRepoIdx = src.indexOf("// Try parsing as \"owner/repo number [message]\"");
		expect(ownerRepoIdx).toBeGreaterThan(-1);
		// Find the end of the owner/repo number handler block by searching for
		// the usage message that follows the handler
		const usageIdx = src.indexOf("Usage:\\n  /ghpr-monitor <PR URL>", ownerRepoIdx);
		expect(usageIdx).toBeGreaterThan(-1);
		const ownerRepoBlock = src.slice(ownerRepoIdx, usageIdx);
		expect(ownerRepoBlock).toContain("sendStartPrompt(config)");
	});

	it("start prompt is NOT sent when already monitoring", () => {
		// In the tool handler: only sent when !result.alreadyMonitoring
		const toolStartIdx = src.indexOf('case "start": {');
		const toolStartBlock = src.slice(toolStartIdx, src.indexOf('case "status": {'));
		expect(toolStartBlock).toContain("!result.alreadyMonitoring");

		// In command handlers: sendStartPrompt is inside the else branch
		// (after checking alreadyMonitoring → warning, else → success + sendStartPrompt)
		const urlHandlerIdx = src.indexOf("// Try parsing as a PR URL first");
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Try parsing as \"owner/repo#number\""));
		// sendStartPrompt should be in the else (not already monitoring) branch
		const successLineIdx = urlBlock.indexOf("ctx.ui.notify(result.message, \"success\")");
		expect(successLineIdx).toBeGreaterThan(-1);
		// The sendStartPrompt should appear after the success notify
		const afterSuccess = urlBlock.slice(successLineIdx);
		expect(afterSuccess).toContain("sendStartPrompt(config)");
	});

	it("start prompt is sent in addition to any user-provided steer message", () => {
		// In the URL handler, both sendStartPrompt and the user steer message are sent
		const urlHandlerIdx = src.indexOf("// Try parsing as a PR URL first");
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Try parsing as \"owner/repo#number\""));
		expect(urlBlock).toContain("sendStartPrompt(config)");
		expect(urlBlock).toContain("pi.sendUserMessage(steerMessage");
		// Both should be present — they serve different purposes
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