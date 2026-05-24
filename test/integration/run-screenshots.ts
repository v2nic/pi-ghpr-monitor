/**
 * Integration test runner for pi-ghpr-monitor
 *
 * Spawns a real Pi agent in tmux against mock servers and captures
 * actual TUI screenshots.
 *
 * Run with: npx tsx test/integration/run-screenshots.ts ./screenshots
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const MOCK_GH_PORT = parseInt(process.env.MOCK_GH_PORT || "9700", 10);
const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT || "9701", 10);
const SCREENSHOT_DIR = process.argv[2] || path.join(__dirname, "screenshots");
const PI_SESSION = "pi-ghpr-test";
const PI_DIR = path.join(SCREENSHOT_DIR, "..", ".pi-integration");

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
				res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
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

function startMockLLMServer(): Promise<http.Server> {
	return new Promise((resolve) => {
		let monitorStarted = false;

		const server = http.createServer((req, res) => {
			const sendJSON = (code: number, body: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
				res.end(JSON.stringify(body));
			};

			if (req.method === "OPTIONS") {
				res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost:${MOCK_LLM_PORT}`);

			if (req.method === "GET" && url.pathname === "/v1/models") {
				sendJSON(200, { object: "list", data: [{ id: "mock-llm", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "test" }] });
				return;
			}

			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				let body = "";
				req.on("data", (c: Buffer) => (body += c.toString()));
				req.on("end", () => {
					console.log("[mock-llm] Chat request received");
					const response = {
						id: `chatcmpl-${Date.now()}`,
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model: "mock-llm",
						choices: [{
							index: 0,
							message: {
								role: "assistant",
								content: !monitorStarted
									? "I'll start monitoring the PR for you. Let me use the ghpr-monitor tool to begin."
									: "Got it, the PR status has been updated.",
							},
							finish_reason: "stop",
						}],
						usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
					};
					monitorStarted = true;
					sendJSON(200, response);
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
// Screenshot helper
// ---------------------------------------------------------------------------

function captureScreenshot(tmuxSession: string, name: string) {
	const outFile = path.join(SCREENSHOT_DIR, `${name}.txt`);
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
		const trimmed = output.replace(/\n+$/, "").trimEnd() + "\n";
		fs.writeFileSync(outFile, trimmed);
		console.log(`  📸 Screenshot saved: ${name}.txt`);
	} catch (err) {
		console.error(`  ⚠️  Failed to capture screenshot: ${(err as Error).message}`);
	}
}

function tmuxSend(tmuxSession: string, command: string) {
	execSync(`tmux send-keys -t ${tmuxSession} "${command}" Enter`, { encoding: "utf-8", shell: "/bin/bash" });
}

function tmuxType(tmuxSession: string, text: string) {
	execSync(`tmux send-keys -t ${tmuxSession} "${text.replace(/"/g, '\\"')}"`, { encoding: "utf-8", shell: "/bin/bash" });
}

// ---------------------------------------------------------------------------
// Pi configuration
// ---------------------------------------------------------------------------

function setupPiConfig() {
	fs.mkdirSync(path.join(PI_DIR, "agent"), { recursive: true });

	// models.json: custom "mock" provider pointing at our mock LLM server
	fs.writeFileSync(path.join(PI_DIR, "agent", "models.json"), JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				apiKey: "mock-key",
				baseUrl: `http://localhost:${MOCK_LLM_PORT}/v1`,
				models: [{
					id: "mock-llm",
					name: "Mock LLM",
					reasoning: false,
					input: ["text"],
					contextWindow: 16384,
					maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	}, null, 2));

	// settings.json
	fs.writeFileSync(path.join(PI_DIR, "agent", "settings.json"), JSON.stringify({
		defaultProvider: "mock",
		defaultModel: "mock-llm",
		enabledModels: ["mock/mock-llm"],
		hideThinkingBlock: true,
		theme: "dark",
	}, null, 2));

	console.log("  📝 Pi config written to", PI_DIR);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const SCENARIO_LABELS: Record<string, string> = {
	"01-extension-loaded": "Extension loaded",
	"02-start-monitoring": "Start monitoring",
	"03-initial-pr-status": "Initial PR status",
	"04-new-comment": "New review comment",
	"05-ci-failing": "CI check fails",
	"06-merge-conflicts": "Merge conflicts detected",
	"07-all-resolved": "All issues resolved",
	"08-stop-monitoring": "Stop monitoring",
	"09-error-handling": "Error handling",
};

function buildScreenshotReport(files: string[]): string {
	const lines: string[] = [
		"# Tmux Screenshots",
		"",
		"Integration test scenarios captured from a real Pi agent session in tmux.",
		"Pi was started with mock GitHub and LLM servers, and `/ghpr-monitor` commands",
		"were issued to trigger actual extension output.",
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
	for (const f of fs.readdirSync(SCREENSHOT_DIR)) {
		if (f !== ".gitignore") {
			fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
		}
	}

	console.log("\n🚀 Starting pi-ghpr-monitor integration test\n");

	// Setup Pi config
	setupPiConfig();

	// Start mock servers
	console.log("1. Starting mock GitHub server...");
	const ghServer = await startMockGitHubServer();
	console.log("2. Starting mock LLM server...");
	const llmServer = await startMockLLMServer();

	// Create tmux session
	console.log("3. Creating tmux session...");
	try { execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`); } catch {}
	execSync(`tmux new-session -d -s ${PI_SESSION} -x 160 -y 45`);
	await new Promise((r) => setTimeout(r, 500));

	// Start Pi in tmux
	console.log("4. Starting Pi agent in tmux...");
	const projectDir = path.resolve(path.join(SCREENSHOT_DIR, "..", ".."));
	tmuxSend(PI_SESSION, `cd ${projectDir} && PI_CODING_AGENT_DIR=${PI_DIR} PI_OFFLINE=1 npx pi --provider mock --model mock-llm --no-session --extension ./src/index.ts >/dev/null 2>&1 &`);
	await new Promise((r) => setTimeout(r, 3000)); // Give Pi time to start

	// SCENARIO 1: Extension loaded
	console.log("\n📋 Scenario 1: Extension loaded");
	captureScreenshot(PI_SESSION, "01-extension-loaded");

	// SCENARIO 2: Start monitoring
	console.log("\n📋 Scenario 2: Start monitoring");
	tmuxSend(PI_SESSION, "/ghpr-monitor https://github.com/v2nic/gh-pr-review/pull/42");
	await new Promise((r) => setTimeout(r, 3000)); // Wait for Pi to process and ghpr-monitor to start
	captureScreenshot(PI_SESSION, "02-start-monitoring");

	// SCENARIO 3: Initial PR status
	console.log("\n📋 Scenario 3: Initial PR status");
	await new Promise((r) => setTimeout(r, 2000)); // Wait for poll
	captureScreenshot(PI_SESSION, "03-initial-pr-status");

	// SCENARIO 4: New review comment
	console.log("\n📋 Scenario 4: New review comment");
	mockState.unresolvedThreads = 3;
	mockState.generalComments = 2;
	mockState.lastCommentBody = "This needs to be fixed before merging";
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "04-new-comment");

	// SCENARIO 5: CI check fails
	console.log("\n📋 Scenario 5: CI check fails");
	mockState.failingChecks = ["ci/test"];
	mockState.pendingChecks = [];
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "05-ci-failing");

	// SCENARIO 6: Merge conflicts
	console.log("\n📋 Scenario 6: Merge conflicts detected");
	mockState.hasConflicts = true;
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "06-merge-conflicts");

	// SCENARIO 7: All issues resolved
	console.log("\n📋 Scenario 7: All issues resolved");
	mockState.unresolvedThreads = 0;
	mockState.generalComments = 0;
	mockState.hasConflicts = false;
	mockState.failingChecks = [];
	mockState.pendingChecks = [];
	mockState.passingChecks = ["ci/test", "ci/build"];
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "07-all-resolved");

	// SCENARIO 8: Stop monitoring
	console.log("\n📋 Scenario 8: Stop monitoring");
	tmuxSend(PI_SESSION, "/ghpr-monitor off");
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "08-stop-monitoring");

	// SCENARIO 9: Error handling
	console.log("\n📋 Scenario 9: Error handling");
	tmuxSend(PI_SESSION, "/ghpr-monitor https://github.com/v2nic/gh-pr-review/pull/99999");
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "09-error-handling");

	// Cleanup
	console.log("\n🧹 Cleaning up...");
	execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`);
	ghServer.close();
	llmServer.close();

	console.log(`\n✅ Integration test complete! Screenshots saved to: ${SCREENSHOT_DIR}`);
	const files = fs.readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith(".txt")).sort();
	console.log("\nScreenshots captured:");
	for (const f of files) {
		const size = fs.statSync(path.join(SCREENSHOT_DIR, f)).size;
		console.log(`  ${f} (${size} bytes)`);
	}

	// Generate markdown report
	const report = buildScreenshotReport(files);
	const reportPath = path.join(SCREENSHOT_DIR, "screenshots-report.md");
	fs.writeFileSync(reportPath, report + "\n");
	console.log(`\n📄 Screenshot report written to: ${reportPath}`);

	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		fs.appendFileSync(stepSummary, report + "\n");
		console.log("📄 Report appended to GITHUB_STEP_SUMMARY");
	}
}

main().catch((err) => {
	console.error("❌ Integration test failed:", err);
	// Try cleanup
	try { execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`); } catch {}
	process.exit(1);
});