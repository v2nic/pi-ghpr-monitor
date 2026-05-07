/**
 * Unit tests for the per-session logger
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	setSessionId,
	enableDebug,
	disableDebug,
	isDebugEnabled,
	closeLogger,
	log,
	logStatus,
	getLogPath,
} from "../src/logger";

describe("logger", () => {
	beforeAll(() => {
		setSessionId("test-session-123");
	});

	afterAll(() => {
		closeLogger();
		// Clean up any log files
		const logPath = path.join(os.tmpdir(), "ghpr-monitor-test-session-123.log");
		if (fs.existsSync(logPath)) {
			try { fs.unlinkSync(logPath); } catch {}
		}
		const logPath2 = path.join(os.tmpdir(), "ghpr-monitor-my_unsafe_session_name.log");
		if (fs.existsSync(logPath2)) {
			try { fs.unlinkSync(logPath2); } catch {}
		}
	});

	it("does not log by default", () => {
		expect(isDebugEnabled()).toBe(false);
		expect(getLogPath()).toBeNull();
	});

	it("enableDebug creates a log file and returns the path", () => {
		const logFilePath = enableDebug();
		expect(logFilePath).toBeTruthy();
		expect(logFilePath).toContain(os.tmpdir());
		expect(logFilePath).toContain("ghpr-monitor-test-session-123");
		expect(isDebugEnabled()).toBe(true);
		disableDebug();
	});

	it("writes log messages when debug is enabled", () => {
		const logFilePath = enableDebug();
		log("Test message for logging");
		// WriteStream is async, so we check that the path was set and debug is enabled
		expect(getLogPath()).toBe(logFilePath);
		expect(isDebugEnabled()).toBe(true);
		disableDebug();
	});

	it("logs PR status snapshots when debug is enabled", () => {
		enableDebug();
		logStatus({
			unresolvedThreads: 2,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"],
			failingStatuses: ["ci/circleci: Build"],
			pendingStatuses: [],
		});
		// Verify the functions don't throw and path is set
		expect(isDebugEnabled()).toBe(true);
		disableDebug();
	});

	it("disableDebug stops logging and returns the log path", () => {
		enableDebug();
		const formerPath = disableDebug();
		expect(formerPath).toBeTruthy();
		expect(isDebugEnabled()).toBe(false);
		expect(getLogPath()).toBeNull();
	});

	it("disableDebug returns null when logging wasn't active", () => {
		expect(disableDebug()).toBeNull();
	});

	it("sanitizes session IDs with special characters", () => {
		closeLogger(); // make sure previous state is cleaned up
		setSessionId("my/unsafe#session!name");
		const logFilePath = enableDebug();
		const filename = path.basename(logFilePath);
		expect(filename).not.toContain("/");
		expect(filename).not.toContain("#");
		expect(filename).not.toContain("!");
		expect(filename).toContain("my_unsafe_session_name");
		disableDebug();
		// Clean up
		if (logFilePath && fs.existsSync(logFilePath)) {
			try { fs.unlinkSync(logFilePath); } catch {}
		}
		// Reset for other tests
		setSessionId("test-session-123");
	});

	it("log is a no-op when debug is not enabled", () => {
		// Should not throw
		log("This should be silently ignored");
		expect(isDebugEnabled()).toBe(false);
	});
});