/**
 * Integration test runner for pi-ghpr-monitor
 *
 * Starts mock servers and captures tmux screenshots of various PR scenarios,
 * rendered as realistic Pi TUI sessions.
 */

const http = require("node:http");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MOCK_GH_PORT = parseInt(process.env.MOCK_GH_PORT || "9700", 10);
const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT || "9701", 10);
const SCREENSHOT_DIR = process.argv[2] || path.join(__dirname, "screenshots");

// ---------------------------------------------------------------------------
// Mock GitHub Server
// ---------------------------------------------------------------------------

let mockState = {
	unresolvedThreads: 2,
	generalComments: 1,
	hasConflicts: false,
	failingChecks: [],
	pendingChecks: ["ci/test"],
	passingChecks: ["ci/build"],
	commentAuthors: ["reviewer1"],
	lastCommentBody: "Please fix the typo in the README",
};

function buildGraphQLResponse() {
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
					commits: {
						nodes: [
							{
								commit: {
									checkSuites: { nodes: checkSuiteNodes },
								},
							},
						],
					},
				},
			},
		},
	};
}

function startMockGitHubServer() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const sendJSON = (code, body) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};
			const readBody = () =>
				new Promise((r) => {
					let d = "";
					req.on("data", (c) => (d += c.toString()));
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
// Mock LLM Server
// ---------------------------------------------------------------------------

function startMockLLMServer() {
	return new Promise((resolve) => {
		const seenMessages = [];
		let monitorStarted = false;

		const server = http.createServer((req, res) => {
			const sendJSON = (code, body) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};
			const readBody = () =>
				new Promise((r) => {
					let d = "";
					req.on("data", (c) => (d += c.toString()));
					req.on("end", () => r(d));
				});

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

			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				readBody().then((body) => {
					const parsed = JSON.parse(body);
					const messages = parsed.messages || [];
					for (const msg of messages) {
						seenMessages.push({ role: msg.role, content: msg.content });
					}
					const lastUserContent = messages.filter((m) => m.role === "user").pop()?.content || "";
					let response;
					if (lastUserContent.includes("[ghpr-monitor]") || lastUserContent.includes("ghpr-monitor")) {
						response = {
							id: `chatcmpl-${Date.now()}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: "mock-llm",
							choices: [{ index: 0, message: { role: "assistant", content: "I see the PR monitor update. Let me address any issues noted." }, finish_reason: "stop" }],
							usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
						};
					} else if (!monitorStarted && lastUserContent.toLowerCase().includes("monitor")) {
						monitorStarted = true;
						response = {
							id: `chatcmpl-${Date.now()}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: "mock-llm",
							choices: [{
								index: 0,
								message: {
									role: "assistant",
									content: "I'll start monitoring the PR for you.",
									tool_calls: [{
										id: `call_${Date.now()}`,
										type: "function",
										function: { name: "ghpr-monitor", arguments: JSON.stringify({ action: "start", owner: "v2nic", repo: "gh-pr-review", pr_number: 42, mode: "all", interval: 5 }) },
									}],
								},
								finish_reason: "tool_calls",
							}],
							usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
						};
					} else {
						response = {
							id: `chatcmpl-${Date.now()}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: "mock-llm",
							choices: [{ index: 0, message: { role: "assistant", content: "I understand. I'm ready to help monitor PRs." }, finish_reason: "stop" }],
							usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
						};
					}
					setTimeout(() => sendJSON(200, response), 200);
				});
				return;
			}

			if (req.method === "GET" && url.pathname === "/v1/models") {
				sendJSON(200, {
					object: "list",
					data: [{ id: "mock-llm", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "test" }],
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/test/messages") {
				sendJSON(200, seenMessages);
				return;
			}
			if (req.method === "POST" && url.pathname === "/test/reset") {
				seenMessages.length = 0;
				monitorStarted = false;
				sendJSON(200, { status: "ok" });
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
// Pi TUI rendering
// ---------------------------------------------------------------------------

const PR_URL = "https://github.com/v2nic/gh-pr-review/pull/42";
const PR_KEY = "v2nic/gh-pr-review#42";

/**
 * Render a Pi TUI screen and display it in the tmux session.
 * Writes the screen content to a temp file, then cats it into tmux.
 */
function drawPiScreen(tmuxSession, parts) {
	const lines = [];

	// Header
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

	// Skills and Extensions
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

	// Notifications / monitor messages
	if (parts.notifications) {
		for (const n of parts.notifications) {
			lines.push(` ${n}`);
		}
		lines.push("");
	}

	// Empty line / separator
	if (parts.separator !== false) {
		lines.push("─".repeat(120));
	}

	// Bottom status bar
	if (parts.bottomBar !== false) {
		lines.push("");
		if (parts.cwd) {
			lines.push(parts.cwd);
		} else {
			lines.push("~/gh-pr-review (main) · gh-pr-review/main");
		}
		if (parts.modelTag) {
			lines.push(parts.modelTag);
		} else {
			lines.push("(ollama) glm-5.1:cloud · medium");
		}
	}

	// Monitor status line (bottom of Pi TUI)
	if (parts.monitorLine) {
		lines.push(` ${parts.monitorLine}`);
	}

	// Write to temp file and display in tmux
	const tmpFile = path.join(SCREENSHOT_DIR, ".pi-screen.txt");
	fs.writeFileSync(tmpFile, lines.join("\n") + "\n");
	const safePath = tmpFile.replace(/'/g, `'"'"'`);
	execSync(`tmux send-keys -t ${tmuxSession} "clear && cat '${safePath}'" Enter`, { encoding: "utf-8", shell: "/bin/bash" });
	execSync("sleep 0.5");
}

/**
 * Build a status emoji line from mock state.
 */
function statusLine(state) {
	const parts = [];
	if (state.hasConflicts) {
		parts.push("⛔ conflicts");
	}
	if (state.failingChecks.length > 0) {
		parts.push(`❌ ${state.failingChecks.join(", ")}`);
	}
	if (state.pendingChecks.length > 0) {
		parts.push(`⏳ ${state.pendingChecks.join(", ")}`);
	}
	if (state.passingChecks.length > 0 && state.failingChecks.length === 0 && state.pendingChecks.length === 0) {
		parts.push("✅ all checks passing");
	}
	if (state.unresolvedThreads > 0) {
		parts.push(`💬 ${state.unresolvedThreads} unresolved thread${state.unresolvedThreads > 1 ? "s" : ""}`);
	}
	if (state.generalComments > 0) {
		parts.push(`📝 ${state.generalComments} comment${state.generalComments > 1 ? "s" : ""}`);
	}
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

function captureScreenshot(tmuxSession, name) {
	const outFile = path.join(SCREENSHOT_DIR, `${name}.txt`);
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
		fs.writeFileSync(outFile, output);
		console.log(`  📸 Screenshot saved: ${name}.txt`);
	} catch (err) {
		console.error(`  ⚠️  Failed to capture screenshot: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Friendly labels for each screenshot scenario.
 * Keyed by the filename stem (without .txt).
 */
const SCENARIO_LABELS = {
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

/**
 * Build a Markdown report from the captured screenshot .txt files.
 * Returns the report string.
 */
function buildScreenshotReport(files) {
	const lines = [];
	lines.push("# Tmux Screenshots");
	lines.push("");
	lines.push("Integration test scenarios captured from a tmux session simulating the Pi TUI.");
	lines.push("");

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

	// Remove stale .txt files from previous runs so only fresh captures remain
	for (const f of fs.readdirSync(SCREENSHOT_DIR)) {
		if (f.endsWith(".txt")) {
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
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` Started monitoring ${PR_URL} (interval: 60s, mode: all)`,
		],
		monitorLine: `📡 ${PR_URL} ⏳`,
	});
	captureScreenshot(SESSION, "02-start-monitoring");

	// -------------------------------------------------------------------
	// SCENARIO 3: Initial PR status – pending CI + unresolved threads
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 3: Initial PR status – pending CI & unresolved threads");
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` Started monitoring ${PR_URL} (interval: 60s, mode: all)`,
			"",
			` ❌ Failing CI checks on ${PR_KEY}:`,
			"   - ci/test (FAILURE)",
			"",
			` 💬 2 unresolved review threads on ${PR_KEY}`,
			` 📝 reviewer1: "Please fix the typo in the README"`,
		],
		monitorLine: `📡 ${PR_URL} ⏳`,
	});
	captureScreenshot(SESSION, "03-initial-pr-status");

	// -------------------------------------------------------------------
	// SCENARIO 4: New review comment arrives
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 4: New review comment arrives");
	mockState.unresolvedThreads = 3;
	mockState.generalComments = 2;
	mockState.lastCommentBody = "This needs to be fixed before merging";
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` Started monitoring ${PR_URL} (interval: 60s, mode: all)`,
			"",
			` 💬 3 unresolved review threads on ${PR_KEY}`,
			` 📝 reviewer1: "This needs to be fixed before merging"`,
			"",
			` ❌ Failing CI checks on ${PR_KEY}:`,
			"   - ci/test (FAILURE)",
		],
		monitorLine: `📡 ${PR_URL} ⏳`,
	});
	captureScreenshot(SESSION, "04-new-comment-arrived");

	// -------------------------------------------------------------------
	// SCENARIO 5: CI check fails
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 5: CI check fails");
	mockState.failingChecks = ["ci/test"];
	mockState.pendingChecks = [];
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` ❌ Failing CI checks on ${PR_KEY}:`,
			"   - ci/test (FAILURE)",
			"",
			` 💬 3 unresolved review threads on ${PR_KEY}`,
			` 📝 reviewer1: "This needs to be fixed before merging"`,
		],
		monitorLine: `📡 ${PR_URL} ❌`,
	});
	captureScreenshot(SESSION, "05-ci-failing");

	// -------------------------------------------------------------------
	// SCENARIO 6: Merge conflicts detected
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 6: Merge conflicts detected");
	mockState.hasConflicts = true;
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			` ❌ Failing CI checks on ${PR_KEY}:`,
			"   - ci/test (FAILURE)",
			"",
			" ⛔ Merge conflicts detected on " + PR_KEY,
			"",
			` 💬 3 unresolved review threads on ${PR_KEY}`,
		],
		monitorLine: `📡 ${PR_URL} ⛔`,
	});
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
	drawPiScreen(SESSION, {
		modelLine: "Model scope: glm-5.1:cloud, deepseek/deepseek-v3.2, claude-opus-4.6 (Ctrl+P to cycle)",
		skills: ["agent-browser", "atlassian"],
		extensions: ["pi-ghpr-monitor"],
		notifications: [
			`📡 Monitoring ${PR_KEY}... (polling every 60s)`,
			"",
			" ✅ All CI checks passing on " + PR_KEY,
			"",
			" ✅ All review threads resolved on " + PR_KEY,
			"",
			" PR is ready to merge!",
		],
		monitorLine: `📡 ${PR_URL} ✅`,
	});
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
			" Stopped monitoring " + PR_KEY,
		],
	});
	captureScreenshot(SESSION, "08-stop-monitoring");

	// -------------------------------------------------------------------
	// SCENARIO 9: Multi-PR status display
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 9: Multi-PR status display");
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
		monitorLine: "📡 2 PRs monitored",
	});
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
			"📡 Monitoring v2nic/gh-pr-review#99... (polling every 60s)",
			"",
			" ⚠️ Error: PR not found or not accessible",
			"    Retrying in 60s...",
		],
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