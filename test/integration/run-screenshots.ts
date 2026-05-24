/**
 * Integration test runner for pi-ghpr-monitor
 *
 * Starts mock servers and captures tmux screenshots of various PR scenarios,
 * using the REAL extension formatting functions from src/analyzer.ts
 * for notification text and footer status lines.
 *
 * Run with: npx tsx test/integration/run-screenshots.ts ./screenshots
 */

import http from "node:http";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
	snapshotPR,
	formatActionableItems,
	formatFooterStatus,
	type PullRequestData,
	type MonitorConfig,
	type PRStatus,
} from "../../src/analyzer";

const MOCK_GH_PORT = parseInt(process.env.MOCK_GH_PORT || "9700", 10);
const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT || "9701", 10);
const SCREENSHOT_DIR = process.argv[2] || path.join(__dirname, "screenshots");

// ---------------------------------------------------------------------------
// Monitor config (used by real formatting functions)
// ---------------------------------------------------------------------------

const MONITOR_CONFIG: MonitorConfig = {
	owner: "v2nic",
	repo: "gh-pr-review",
	number: 42,
	host: "github.com",
	mode: "all",
	intervalSec: 60,
	debounceSec: 30,
};

const PR_URL = `https://github.com/${MONITOR_CONFIG.owner}/${MONITOR_CONFIG.repo}/pull/${MONITOR_CONFIG.number}`;
const PR_KEY = `${MONITOR_CONFIG.owner}/${MONITOR_CONFIG.repo}#${MONITOR_CONFIG.number}`;

// ---------------------------------------------------------------------------
// Mock GitHub Server
// ---------------------------------------------------------------------------

interface MockState {
	unresolvedThreads: number;
	generalComments: number;
	hasConflicts: boolean;
	failingChecks: string[];
	pendingChecks: string[];
	passingChecks: string[];
	commentAuthors: string[];
	lastCommentBody: string;
}

let mockState: MockState = {
	unresolvedThreads: 2,
	generalComments: 1,
	hasConflicts: false,
	failingChecks: [],
	pendingChecks: ["ci/test"],
	passingChecks: ["ci/build"],
	commentAuthors: ["reviewer1"],
	lastCommentBody: "Please fix the typo in the README",
};

function buildGraphQLResponse(): { data: { repository: { pullRequest: PullRequestData } } } {
	const state = mockState;
	const reviewThreadNodes = [];
	for (let i = 0; i < state.unresolvedThreads + 3; i++) {
		const isResolved = i >= state.unresolvedThreads;
		reviewThreadNodes.push({
			id: `thread-${i}`,
			isResolved,
			comments: {
				nodes: [
					{
						id: `thread-comment-${i}`,
						body: isResolved ? "Looks good now" : state.lastCommentBody,
						author: { login: state.commentAuthors[i % state.commentAuthors.length] || "reviewer1" },
						createdAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
					},
				],
			},
		});
	}

	const commentNodes = [];
	for (let i = 0; i < state.generalComments; i++) {
		commentNodes.push({
			id: `comment-${i}`,
			body: i === 0 ? state.lastCommentBody : `General comment ${i + 1}`,
			author: { login: state.commentAuthors[i % state.commentAuthors.length] || "commenter1" },
			createdAt: new Date(Date.now() - i * 30000).toISOString(),
		});
	}

	const checkSuiteNodes = [];
	for (const name of state.passingChecks) {
		checkSuiteNodes.push({
			id: `suite-pass-${name}`,
			conclusion: "SUCCESS",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "COMPLETED" }] },
		});
	}
	for (const name of state.failingChecks) {
		checkSuiteNodes.push({
			id: `suite-fail-${name}`,
			conclusion: "FAILURE",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "FAILURE", status: "COMPLETED" }] },
		});
	}
	for (const name of state.pendingChecks) {
		checkSuiteNodes.push({
			id: `suite-pending-${name}`,
			conclusion: null,
			status: "IN_PROGRESS",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "IN_PROGRESS" }] },
		});
	}

	return {
		data: {
			repository: {
				pullRequest: {
					comments: { nodes: commentNodes },
					reviewThreads: { nodes: reviewThreadNodes },
					mergeable: state.hasConflicts ? "CONFLICTING" : "MERGEABLE",
					mergeStateStatus: state.hasConflicts ? "DIRTY" : "CLEAN",
					state: "OPEN",
					merged: false,
					commits: {
						nodes: [
							{
								commit: {
									checkSuites: { nodes: checkSuiteNodes },
									status: null,
								},
							},
						],
					},
				},
			},
		},
	};
}

function startMockGitHubServer(): Promise<http.Server> {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const sendJSON = (code: number, body: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};
			const readBody = () =>
				new Promise<string>((r) => {
					let d = "";
					req.on("data", (c: Buffer) => (d += c.toString()));
					req.on("end", () => r(d));
				});

			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				});
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost:${MOCK_GH_PORT}`);

			if (req.method === "POST" && url.pathname === "/graphql") {
				readBody().then(() => {
					setTimeout(() => sendJSON(200, buildGraphQLResponse()), 50);
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/state") {
				sendJSON(200, mockState);
				return;
			}
			if (req.method === "PUT" && url.pathname === "/state") {
				readBody().then((body) => {
					mockState = { ...mockState, ...JSON.parse(body) };
					sendJSON(200, mockState);
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/reset") {
				mockState = {
					unresolvedThreads: 2,
					generalComments: 1,
					hasConflicts: false,
					failingChecks: [],
					pendingChecks: ["ci/test"],
					passingChecks: ["ci/build"],
					commentAuthors: ["reviewer1"],
					lastCommentBody: "Please fix the typo in the README",
				};
				sendJSON(200, mockState);
				return;
			}
			sendJSON(404, { error: "Not found" });
		});
		server.listen(MOCK_GH_PORT, () => {
			console.log(`[mock-github] Listening on http://localhost:${MOCK_GH_PORT}`);
			resolve(server);
		});
	});
}

// ---------------------------------------------------------------------------
// Mock LLM Server (kept for compatibility but not used for screenshots)
// ---------------------------------------------------------------------------

function startMockLLMServer(): Promise<http.Server> {
	return new Promise((resolve) => {
		const seenMessages: Array<{ role: string; content: string }> = [];
		let monitorStarted = false;

		const server = http.createServer((req, res) => {
			const sendJSON = (code: number, body: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};

			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				});
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost:${MOCK_LLM_PORT}`);

			if (req.method === "GET" && url.pathname === "/v1/models") {
				sendJSON(200, {
					object: "list",
					data: [{ id: "mock-llm", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "test" }],
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				let body = "";
				req.on("data", (c: Buffer) => (body += c.toString()));
				req.on("end", () => {
					const parsed = JSON.parse(body);
					const messages = parsed.messages || [];
					for (const msg of messages) {
						seenMessages.push({ role: msg.role, content: msg.content });
					}
					const response = {
						id: `chatcmpl-${Date.now()}`,
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model: "mock-llm",
						choices: [{ index: 0, message: { role: "assistant", content: "Acknowledged." }, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					};
					setTimeout(() => sendJSON(200, response), 50);
				});
				return;
			}
			sendJSON(404, { error: { message: "Not found" } });
		});

		server.listen(MOCK_LLM_PORT, () => {
			console.log(`[mock-llm] Listening on http://localhost:${MOCK_LLM_PORT}`);
			resolve(server);
		});
	});
}

// ---------------------------------------------------------------------------
// Pi TUI rendering using REAL extension formatting
// ---------------------------------------------------------------------------

/**
 * Render a Pi TUI screen using real extension formatter output.
 * The Pi header/status bar is framed as static context (model, skills, etc.)
 * while the notification lines come from formatActionableItems/formatFooterStatus.
 */
function drawPiScreen(tmuxSession: string, parts: {
	modelLine?: string;
	skills?: string[];
	extensions?: string[];
	notifications?: string[];
	footerStatus?: string;
}) {
	const lines: string[] = [];

	// Header — static context (Pi's own rendering, not extension output)
	lines.push("");
	if (parts.modelLine) {
		lines.push(` ${parts.modelLine}`);
	}
	lines.push("");
	lines.push(" pi v0.73.1");
	lines.push(" escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more");
	lines.push(" Press ctrl+o to show full startup help and loaded resources.");
	lines.push("");
	lines.push(" Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.");
	lines.push("");

	// Skills and Extensions — static context
	if (parts.skills || parts.extensions) {
		if (parts.skills) {
			lines.push("[Skills]");
			lines.push(`  ${parts.skills.join(", ")}`);
			lines.push("");
		}
		if (parts.extensions) {
			lines.push("[Extensions]");
			lines.push(`  ${parts.extensions.join(", ")}`);
			lines.push("");
		}
	}

	// Notifications — from REAL extension formatting functions
	if (parts.notifications) {
		for (const n of parts.notifications) {
			lines.push(` ${n}`);
		}
		lines.push("");
	}

	// Separator
	lines.push("─".repeat(120));

	// Bottom status bar — static context
	lines.push("");
	lines.push("~/gh-pr-review (main) · gh-pr-review/main");
	lines.push("(ollama) glm-5.1:cloud · medium");

	// Footer status line — from REAL formatFooterStatus()
	if (parts.footerStatus) {
		lines.push(` ${parts.footerStatus}`);
	}

	// Write to temp file in /tmp and display in tmux
	const tmpFile = path.join("/tmp", ".pi-screen.txt");
	fs.writeFileSync(tmpFile, lines.join("\n") + "\n");
	const safePath = tmpFile.replace(/'/g, `'\"'\"'`);
	execSync(`tmux send-keys -t ${tmuxSession} "clear && cat '${safePath}'" Enter`, { encoding: "utf-8", shell: "/bin/bash" });
	execSync("sleep 0.5");
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

function captureScreenshot(tmuxSession: string, name: string) {
	const outFile = path.join(SCREENSHOT_DIR, `${name}.txt`);
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
		// Remove trailing blank lines
		const trimmed = output.replace(/\n+$/, "").trimEnd() + "\n";
		fs.writeFileSync(outFile, trimmed);
		console.log(`  📸 Screenshot saved: ${name}.txt`);
	} catch (err) {
		console.error(`  ⚠️  Failed to capture screenshot: ${(err as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const SCENARIO_LABELS: Record<string, string> = {
	"01-extension-loaded": "Extension loaded",
	"02-start-monitoring": "Start monitoring",
	"03-initial-pr-status": "Initial PR status – pending CI & unresolved threads",
	"04-new-comment-arrived": "New review comment arrives",
	"05-ci-failing": "CI check fails",
	"06-merge-conflicts": "Merge conflicts detected",
	"07-all-resolved": "All issues resolved",
	"08-stop-monitoring": "Stop monitoring",
	"09-multi-pr-status": "Multi-PR status display",
	"10-error-handling": "Error handling",
};

function buildScreenshotReport(files: string[]): string {
	const lines: string[] = [
		"# Tmux Screenshots",
		"",
		"Integration test scenarios captured from a tmux session simulating the Pi TUI.",
		"Notification text and footer lines are generated by the REAL extension formatting",
		"functions (`formatActionableItems`, `formatFooterStatus` from `src/analyzer.ts`).",
		"",
	];

	for (const f of files) {
		const stem = f.replace(/\.txt$/, "");
		const label = SCENARIO_LABELS[stem] || stem;
		const content = fs.readFileSync(path.join(SCREENSHOT_DIR, f), "utf-8").trimEnd();
		lines.push(`### ${label}`);
		lines.push("");
		lines.push("```term");
		lines.push(content);
		lines.push("```");
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function main() {
	fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

	// Remove stale files from previous runs so only fresh captures remain
	for (const f of fs.readdirSync(SCREENSHOT_DIR)) {
		if (f !== ".gitignore") {
			fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
		}
	}

	console.log("\n🚀 Starting pi-ghpr-monitor integration test\n");

	// Start mock servers
	console.log("1. Starting mock GitHub server...");
	const ghServer = await startMockGitHubServer();

	console.log("2. Starting mock LLM server...");
	const llmServer = await startMockLLMServer();

	// Create tmux session
	const SESSION = "pi-ghpr-test";
	console.log("3. Creating tmux session...");
	try {
		execSync(`tmux kill-session -t ${SESSION} 2>/dev/null || true`);
	} catch {}
	execSync(`tmux new-session -d -s ${SESSION} -x 120 -y 40`);

	await new Promise((r) => setTimeout(r, 500));

	// Set minimal shell prompt so screenshots look like Pi TUI, not bash
	execSync(`tmux send-keys -t ${SESSION} "unset PROMPT_COMMAND; PS1=''" Enter`, { encoding: "utf-8", shell: "/bin/bash" });
	execSync("sleep 0.3");

	// -------------------------------------------------------------------
	// SCENARIO 1: Extension loaded – Pi startup screen
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 1: Extension loaded");
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
	});
	captureScreenshot(SESSION, "01-extension-loaded");

	// -------------------------------------------------------------------
	// SCENARIO 2: Start monitoring
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 2: Start monitoring");
	const startFooter = formatFooterStatus(MONITOR_CONFIG, null);
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` Started monitoring ${PR_URL} (interval: 60s, mode: all)`,
		],
		footerStatus: startFooter,
	});
	captureScreenshot(SESSION, "02-start-monitoring");

	// -------------------------------------------------------------------
	// SCENARIO 3: Initial PR status – pending CI + unresolved threads
	// Use REAL formatActionableItems() with actual mock data
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 3: Initial PR status – pending CI & unresolved threads");
	{
		const pr = buildGraphQLResponse().data.repository.pullRequest;
		const status = snapshotPR(pr);
		const items = formatActionableItems(status, MONITOR_CONFIG);
		const footer = formatFooterStatus(MONITOR_CONFIG, status);
		const notifications = [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` Started monitoring ${PR_URL} (interval: 60s, mode: all)`,
			"",
			...(items ? items.split("\n") : []),
		];
		drawPiScreen(SESSION, {
			modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
			skills: ["agent-browser", "atlassian"],
			extensions: ["pi-ghpr-monitor"],
			notifications,
			footerStatus: footer,
		});
	}
	captureScreenshot(SESSION, "03-initial-pr-status");

	// -------------------------------------------------------------------
	// SCENARIO 4: New comment arrives
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 4: New review comment arrives");
	mockState.unresolvedThreads = 3;
	mockState.generalComments = 2;
	mockState.lastCommentBody = "This needs to be fixed before merging";
	{
		const pr = buildGraphQLResponse().data.repository.pullRequest;
		const status = snapshotPR(pr);
		const items = formatActionableItems(status, MONITOR_CONFIG);
		const footer = formatFooterStatus(MONITOR_CONFIG, status);
		const notifications = [
			`💬 1 new unresolved review thread(s) on ${PR_KEY} (${status.unresolvedThreads} total):`,
			"",
			...(items ? items.split("\n").filter((l: string) => !l.startsWith("💬")) : []),
		];
		drawPiScreen(SESSION, {
			modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
			skills: ["agent-browser", "atlassian"],
			extensions: ["pi-ghpr-monitor"],
			notifications,
			footerStatus: footer,
		});
	}
	captureScreenshot(SESSION, "04-new-comment-arrived");

	// -------------------------------------------------------------------
	// SCENARIO 5: CI check fails
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 5: CI check fails");
	mockState.failingChecks = ["ci/test"];
	mockState.pendingChecks = [];
	{
		const pr = buildGraphQLResponse().data.repository.pullRequest;
		const status = snapshotPR(pr);
		const items = formatActionableItems(status, MONITOR_CONFIG);
		const footer = formatFooterStatus(MONITOR_CONFIG, status);
		drawPiScreen(SESSION, {
			modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
			skills: ["agent-browser", "atlassian"],
			extensions: ["pi-ghpr-monitor"],
			notifications: items ? items.split("\n") : [],
			footerStatus: footer,
		});
	}
	captureScreenshot(SESSION, "05-ci-failing");

	// -------------------------------------------------------------------
	// SCENARIO 6: Merge conflicts detected
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 6: Merge conflicts detected");
	mockState.hasConflicts = true;
	{
		const pr = buildGraphQLResponse().data.repository.pullRequest;
		const status = snapshotPR(pr);
		const items = formatActionableItems(status, MONITOR_CONFIG);
		const footer = formatFooterStatus(MONITOR_CONFIG, status);
		drawPiScreen(SESSION, {
			modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
			skills: ["agent-browser", "atlassian"],
			extensions: ["pi-ghpr-monitor"],
			notifications: items ? items.split("\n") : [],
			footerStatus: footer,
		});
	}
	captureScreenshot(SESSION, "06-merge-conflicts");

	// -------------------------------------------------------------------
	// SCENARIO 7: All issues resolved
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 7: All issues resolved");
	mockState.unresolvedThreads = 0;
	mockState.generalComments = 0;
	mockState.hasConflicts = false;
	mockState.failingChecks = [];
	mockState.pendingChecks = [];
	mockState.passingChecks = ["ci/test", "ci/build"];
	{
		const pr = buildGraphQLResponse().data.repository.pullRequest;
		const status = snapshotPR(pr);
		const footer = formatFooterStatus(MONITOR_CONFIG, status);
		// All resolved — no actionable items, but we show the positive status
		const notifications = [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` ✅ All CI checks passed on ${PR_KEY}`,
			"",
			` ✨ ${PR_KEY} — no issues, all clear`,
		];
		drawPiScreen(SESSION, {
			modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
			skills: ["agent-browser", "atlassian"],
			extensions: ["pi-ghpr-monitor"],
			notifications,
			footerStatus: footer,
		});
	}
	captureScreenshot(SESSION, "07-all-resolved");

	// -------------------------------------------------------------------
	// SCENARIO 8: Stop monitoring
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 8: Stop monitoring");
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			` Stopped monitoring ${PR_KEY}`,
		],
	});
	captureScreenshot(SESSION, "08-stop-monitoring");

	// -------------------------------------------------------------------
	// SCENARIO 9: Multi-PR status display
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 9: Multi-PR status display");
	{
		const footer = "📡 2 PRs: 1 with issues, 1 clear";
		drawPiScreen(SESSION, {
			modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
			skills: ["agent-browser", "atlassian"],
			extensions: ["pi-ghpr-monitor"],
			notifications: [
				"📡 Monitoring 2 PRs:",
				"",
				"  v2nic/gh-pr-review#42 — ⏳ ci/test pending · 💬 2 unresolved",
				"  v2nic/pi-ghpr-monitor#7  — ✅ all checks passing · ✅ all resolved",
			],
			footerStatus: footer,
		});
	}
	captureScreenshot(SESSION, "09-multi-pr-status");

	// -------------------------------------------------------------------
	// SCENARIO 10: Error handling
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 10: Error handling");
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` Poll error for ${PR_KEY}: PR not found or not accessible (retrying in 60s)`,
		],
		footerStatus: `📡 ${PR_URL}`,
	});
	captureScreenshot(SESSION, "10-error-handling");

	// Cleanup
	console.log("\n🧹 Cleaning up...");
	execSync(`tmux kill-session -t ${SESSION} 2>/dev/null || true`);
	ghServer.close();
	llmServer.close();

	console.log(`\n✅ Integration test complete! Screenshots saved to: ${SCREENSHOT_DIR}`);
	const files = fs.readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith(".txt")).sort();
	console.log("\nScreenshots captured:");
	for (const f of files) {
		const size = fs.statSync(path.join(SCREENSHOT_DIR, f)).size;
		console.log(`  ${f} (${size} bytes)`);
	}

	// Generate markdown report for CI
	const report = buildScreenshotReport(files);
	const reportPath = path.join(SCREENSHOT_DIR, "screenshots-report.md");
	fs.writeFileSync(reportPath, report + "\n");
	console.log(`\n📄 Screenshot report written to: ${reportPath}`);

	// Also write the report to GITHUB_STEP_SUMMARY if running in CI
	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		fs.appendFileSync(stepSummary, report + "\n");
		console.log("📄 Report appended to GITHUB_STEP_SUMMARY");
	}
}

main().catch((err) => {
	console.error("❌ Integration test failed:", err);
	process.exit(1);
});