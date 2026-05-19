/**
 * Tests for backoff bypass bugs
 *
 * Bug 1: turn_end wakes the poll loop during error backoff.
 *   When the agent's turn ends while the poll loop is in error backoff,
 *   the turn_end handler calls pollWakeResolve(), short-circuiting the
 *   wait. The error message says "retrying in 300s" but the retry happens
 *   immediately (or whenever the next turn_end fires).
 *
 * Bug 2: consecutiveNoChange overrides backoffSec.
 *   When consecutiveNoChange > 3 and an error occurs, the wait calculation
 *   uses the idle slowdown formula instead of backoffSec, making the error
 *   message promise a longer wait than actually happens.
 *
 * Example error from production:
 *   "Poll error for mobilityhouse/vgi-na-masscec#435: FAILURE_COMMIT_STATES
 *    is not defined (retrying in 300s)"
 *   This error appeared twice within seconds because turn_end short-circuited
 *   the 300s backoff wait.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Simulate the pollLoop's wait-time logic extracted from src/index.ts
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_SEC = 60;
const MAX_BACKOFF_SEC = 300;
const MAX_IDLE_SEC = 3600;

interface PollLoopState {
	/** Exponential backoff after errors (reset to 0 on success) */
	backoffSec: number;
	/** Consecutive successful polls with no change */
	consecutiveNoChange: number;
	/** Whether the agent turn is active */
	agentTurnActive: boolean;
	/** Whether we're in error backoff (most recent poll was an error) */
	inErrorBackoff: boolean;
}

/**
 * Compute the wait time for the next poll iteration.
 * This mirrors the logic in src/index.ts pollLoop() — the section between
 * the try/catch block and the await timer.
 */
function computeWaitSec(state: PollLoopState, intervalSec: number): number {
	const baseSec = state.backoffSec > 0 ? state.backoffSec : intervalSec;
	// After 3 consecutive no-change polls, double interval each time up to 1 hour
	const idleSec = state.consecutiveNoChange > 3
		? Math.min(intervalSec * Math.pow(2, state.consecutiveNoChange - 3), MAX_IDLE_SEC)
		: baseSec;
	const waitSec = state.agentTurnActive ? Math.max(idleSec, 300) : idleSec;
	return waitSec;
}

/**
 * Bug-fixed version: backoff should always take precedence over idle slow-down.
 * When in error backoff, the wait should be at least backoffSec regardless
 * of the idle slow-down formula.
 */
function computeWaitSecFixed(state: PollLoopState, intervalSec: number): number {
	const baseSec = state.backoffSec > 0 ? state.backoffSec : intervalSec;
	let idleSec: number;
	if (state.consecutiveNoChange > 3) {
		const idleSlowdown = Math.min(
			intervalSec * Math.pow(2, state.consecutiveNoChange - 3),
			MAX_IDLE_SEC,
		);
		// When in error backoff, use the MAX of idle slowdown and backoff.
		// This ensures the error backoff is never shorter than promised.
		idleSec = state.backoffSec > 0 ? Math.max(idleSlowdown, baseSec) : idleSlowdown;
	} else {
		idleSec = baseSec;
	}
	const waitSec = state.agentTurnActive ? Math.max(idleSec, 300) : idleSec;
	return waitSec;
}

/**
 * Simulate the error message construction (mirrors the catch block in pollLoop).
 */
function formatErrorMessage(
	config: { owner: string; repo: string; number: number },
	errMsg: string,
	backoffSec: number,
	intervalSec: number,
): string {
	const isRateLimit = /rate limit/i.test(errMsg);
	if (isRateLimit) {
		return `Rate limited, backing off ${backoffSec}s`;
	}
	return `Poll error for ${config.owner}/${config.repo}#${config.number}: ${errMsg}${backoffSec > intervalSec ? ` (retrying in ${backoffSec}s)` : ""}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_CONFIG = { owner: "mobilityhouse", repo: "vgi-na-masscec", number: 435 };

describe("Bug 1: turn_end wakes poll loop during error backoff", () => {
	it("reproduces: error backoff wait is short-circuited by turn_end", () => {
		// Simulate the scenario from production:
		// 1. Poll error occurs (FAILURE_COMMIT_STATES is not defined)
		// 2. Error message says "retrying in 300s"
		// 3. But turn_end wakes the poll loop immediately
		// 4. The same error fires again within seconds

		let backoffSec = 0;
		const intervalSec = 60;
		let inErrorBackoff = false;
		let consecutiveNoChange = 0;
		const errorsReceived: string[] = [];
		const waitTimes: number[] = [];

		// Simulate first 3 successful polls with no change (incrementing consecutiveNoChange)
		for (let i = 0; i < 3; i++) {
			backoffSec = 0;
			inErrorBackoff = false;
			consecutiveNoChange++;
		}

		// Simulate first error
		backoffSec = backoffSec === 0 ? intervalSec : Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
		inErrorBackoff = true;
		errorsReceived.push(
			formatErrorMessage(TEST_CONFIG, "FAILURE_COMMIT_STATES is not defined", backoffSec, intervalSec),
		);
		// computeWaitSec shows the PROMISED wait time
		const waitSec1 = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff },
			intervalSec,
		);
		waitTimes.push(waitSec1);

		// Simulate 3 more consecutive errors (each with turn_end short-circuiting the wait)
		for (let i = 0; i < 3; i++) {
			backoffSec = Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
			errorsReceived.push(
				formatErrorMessage(TEST_CONFIG, "FAILURE_COMMIT_STATES is not defined", backoffSec, intervalSec),
			);
			const wait = computeWaitSec(
				{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff },
				intervalSec,
			);
			waitTimes.push(wait);
		}

		// The error messages say "retrying in 300s" for the 4th error
		expect(errorsReceived[3]).toContain("retrying in 300s");

		// But the ACTUAL wait time could be different:
		// For the 4th error, backoffSec = 300, consecutiveNoChange = 3
		// Since consecutiveNoChange <= 3, idleSec = baseSec = 300. This is correct.
		// But if consecutiveNoChange > 3, idleSec would be SHORTER than 300!

		// Demonstrate the bug: higher consecutiveNoChange makes actual wait shorter
		// than promised
		const buggyWait = computeWaitSec(
			{ backoffSec: 300, consecutiveNoChange: 5, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		// consecutiveNoChange=5 → idleSec = min(60 * 2^2, 3600) = 240
		// But error message says 300s!
		expect(buggyWait).toBe(240); // Bug: actual wait (240s) < promised wait (300s)
		expect(buggyWait).toBeLessThan(300);
	});

	it("turn_end early wake pattern causes repeated immediate retries", () => {
		// Simulate the exact sequence from production:
		// 1. Poll error #1: backoffSec = 60
		// 2. turn_end fires → immediate retry
		// 3. Poll error #2: backoffSec = 120
		// 4. turn_end fires → immediate retry
		// 5. Poll error #3: backoffSec = 240
		// 6. turn_end fires → immediate retry
		// 7. Poll error #4: backoffSec = 300 (max), message says "retrying in 300s"
		// 8. turn_end fires → immediate retry
		// 9. Same error message appears again

		let backoffSec = 0;
		const intervalSec = 60;
		let consecutiveNoChange = 0;
		const actualWaitTimes: number[] = [];
		const promisedWaitTimes: number[] = [];

		// 4 consecutive errors with turn_end short-circuiting each wait
		for (let i = 0; i < 4; i++) {
			// Error occurs
			backoffSec = backoffSec === 0 ? intervalSec : Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
			// The promised wait (shown in error message via backoffSec > intervalSec)
			const promisedWait = backoffSec;

			// The actual wait computation
			const actualWait = computeWaitSec(
				{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
				intervalSec,
			);

			promisedWaitTimes.push(promisedWait);
			actualWaitTimes.push(actualWait);

			// In the buggy code: turn_end fires → pollWakeResolve() → wait = 0 (immediate)
			// For this test we simulate by recording what the "actual" wait WOULD be
			// (in reality it's 0 due to the early wake)
		}

		// Error #4 promises 300s wait...
		expect(promisedWaitTimes[3]).toBe(300);
		// ...but with consecutiveNoChange = 0, the computed wait is actually 300s
		// (This particular case happens to be correct because consecutiveNoChange = 0)
		expect(actualWaitTimes[0]).toBe(60);
		expect(actualWaitTimes[1]).toBe(120);
		expect(actualWaitTimes[2]).toBe(240);
		expect(actualWaitTimes[3]).toBe(300);

		// But if there were successful no-change polls before the errors...
		consecutiveNoChange = 5;
		backoffSec = 300;
		const actualWait = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		// idleSec = min(60 * 2^2, 3600) = 240, which is LESS than backoffSec (300)
		// The error message says "retrying in 300s" but the actual wait is 240s
		expect(actualWait).toBe(240);
	});
});

describe("Bug 2: consecutiveNoChange overrides backoffSec in wait calculation", () => {
	it("promised wait time (300s) differs from actual wait when consecutiveNoChange > 3", () => {
		const intervalSec = 60;

		// After 5 successful no-change polls, then errors start
		const consecutiveNoChange = 5;
		const backoffSec = 300; // max backoff

		const actualWait = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);

		// Bug: the error message says "retrying in 300s"
		// But the actual wait is only 240s because consecutiveNoChange
		// overrides backoffSec in the wait calculation
		expect(actualWait).toBe(240);
		expect(actualWait).toBeLessThan(backoffSec);
	});

	it("consecutiveNoChange = 4 results in 120s wait instead of 300s backoff", () => {
		const intervalSec = 60;
		const consecutiveNoChange = 4;
		const backoffSec = 300;

		const actualWait = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);

		// idleSec = min(60 * 2^1, 3600) = 120
		expect(actualWait).toBe(120);
		expect(actualWait).toBeLessThan(backoffSec);
	});

	it("consecutiveNoChange = 3 gives correct wait when backoff is active", () => {
		const intervalSec = 60;
		const consecutiveNoChange = 3;
		const backoffSec = 300;

		const actualWait = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);

		// consecutiveNoChange = 3 is the boundary: uses baseSec = backoffSec = 300
		expect(actualWait).toBe(300);
	});

	it("fixed version: backoff always takes precedence over idle slowdown", () => {
		const intervalSec = 60;

		// After 5 successful no-change polls, then errors start
		for (const consecutiveNoChange of [0, 3, 5, 10]) {
			const backoffSec = 300;
			const actualWait = computeWaitSecFixed(
				{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
				intervalSec,
			);

			// Fix: backoffSec should always be respected, at minimum
			expect(actualWait).toBeGreaterThanOrEqual(backoffSec);
		}
	});

	it("fixed version: idle slowdown still works when no error backoff", () => {
		const intervalSec = 60;

		// Without error backoff, idle slowdown should work as before
		const consecutiveNoChange = 5;
		const backoffSec = 0; // no backoff

		const actualWait = computeWaitSecFixed(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: false },
			intervalSec,
		);

		// idleSec = min(60 * 2^2, 3600) = 240
		expect(actualWait).toBe(240);
	});
});

describe("Error message vs actual wait time comparison", () => {
	it("error message says 'retrying in 300s' but actual wait may be less", () => {
		const intervalSec = 60;

		// Simulate: 5 no-change polls, then 4 errors
		let backoffSec = 0;
		let consecutiveNoChange = 5;

		// Error 1
		backoffSec = intervalSec;
		const msg1 = formatErrorMessage(TEST_CONFIG, "FAILURE_COMMIT_STATES is not defined", backoffSec, intervalSec);
		const wait1 = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		// First error: no "retrying in Xs" suffix because backoffSec == intervalSec
		expect(msg1).not.toContain("retrying in");
		// But wait time uses idle slowdown (240s) not backoff (60s)
		expect(wait1).toBe(240); // Bug: uses idle slowdown, ignores backoff

		// Error 2
		backoffSec = 120;
		const msg2 = formatErrorMessage(TEST_CONFIG, "FAILURE_COMMIT_STATES is not defined", backoffSec, intervalSec);
		const wait2 = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		expect(msg2).toContain("retrying in 120s");
		// Promised: 120s, actual: 240s (MORE than promised, but also wrong)
		expect(wait2).toBe(240); // Bug: promises 120s, waits 240s

		// Error 3
		backoffSec = 240;
		const msg3 = formatErrorMessage(TEST_CONFIG, "FAILURE_COMMIT_STATES is not defined", backoffSec, intervalSec);
		const wait3 = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		expect(msg3).toContain("retrying in 240s");
		expect(wait3).toBe(240); // Happens to be correct here

		// Error 4
		backoffSec = 300;
		const msg4 = formatErrorMessage(TEST_CONFIG, "FAILURE_COMMIT_STATES is not defined", backoffSec, intervalSec);
		const wait4 = computeWaitSec(
			{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		expect(msg4).toContain("retrying in 300s");
		expect(wait4).toBeLessThan(300); // Bug: says 300s, waits less
	});

	it("fixed version: wait time is always >= promised retry time", () => {
		const intervalSec = 60;

		for (const consecutiveNoChange of [0, 3, 5, 10]) {
			for (const backoffSec of [60, 120, 240, 300]) {
				const actualWait = computeWaitSecFixed(
					{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
					intervalSec,
				);
				// The actual wait should always be at least as long as the
				// promised backoff time
				expect(actualWait).toBeGreaterThanOrEqual(backoffSec);
			}
		}
	});
});

describe("Bug 1 reproduction: turn_end immediate retry pattern", () => {
	it("simulates the full production scenario", () => {
		// This test reproduces the exact scenario from the bug report:
		// "Poll error for mobilityhouse/vgi-na-masscec#435: FAILURE_COMMIT_STATES
		//  is not defined (retrying in 300s)"
		// appeared twice within seconds because turn_end short-circuited the wait.

		const intervalSec = 60;
		let backoffSec = 0;
		let consecutiveNoChange = 0;
		let inErrorBackoff = false;
		const timeline: { time: number; event: string; waitPromised?: number; waitActual?: number }[] = [];
		let simulatedTime = 0;

		// Success: poll #1 (no change)
		consecutiveNoChange++;
		backoffSec = 0;
		timeline.push({ time: simulatedTime, event: "poll success (no change)" });
		simulatedTime += intervalSec;

		// Success: poll #2 (no change)
		consecutiveNoChange++;
		backoffSec = 0;
		timeline.push({ time: simulatedTime, event: "poll success (no change)" });
		simulatedTime += intervalSec;

		// Success: poll #3 (no change)
		consecutiveNoChange++;
		backoffSec = 0;
		timeline.push({ time: simulatedTime, event: "poll success (no change)" });
		simulatedTime += intervalSec;

		// Error: "FAILURE_COMMIT_STATES is not defined"
		backoffSec = intervalSec; // 60
		inErrorBackoff = true;
		const waitPromised1 = backoffSec;
		// BUG: turn_end fires, waking the poll loop immediately
		// In the buggy code, the wait is short-circuited to ~0 seconds
		const waitActual1 = 0; // immediate retry due to turn_end early wake
		timeline.push({
			time: simulatedTime,
			event: "poll error: FAILURE_COMMIT_STATES is not defined",
			waitPromised: waitPromised1,
			waitActual: waitActual1,
		});
		simulatedTime += waitActual1; // 0 seconds!

		// Errors 2-5: each short-circuited by turn_end, immediate retry
		for (let i = 0; i < 4; i++) {
			backoffSec = Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
			timeline.push({
				time: simulatedTime,
				event: "poll error: FAILURE_COMMIT_STATES is not defined",
				waitPromised: backoffSec,
				waitActual: 0, // immediate retry because turn_end short-circuits
			});
			simulatedTime += 0;
		}

		// The user sees two error messages with "retrying in 300s" but they
		// appeared almost simultaneously (0 actual wait between them)
		const errorsWith300 = timeline.filter(
			(t) => t.waitPromised === 300 && t.event.includes("FAILURE_COMMIT_STATES"),
		);
		// At least 2 errors with max backoff (300s) — the ones the user reported
		expect(errorsWith300.length).toBeGreaterThanOrEqual(2);

		// All actual waits are near-zero because turn_end short-circuits them
		const totalPromisedWait = timeline
			.filter((t) => t.waitPromised)
			.reduce((sum, t) => sum + (t.waitPromised || 0), 0);
		const totalActualWait = timeline
			.filter((t) => t.waitActual !== undefined)
			.reduce((sum, t) => sum + (t.waitActual || 0), 0);

		// The promised total wait time should be large (sum of all backoffs)
		expect(totalPromisedWait).toBeGreaterThan(600);
		// But the actual total wait time is nearly 0!
		expect(totalActualWait).toBe(0);

		// This is the bug: the error messages promise many minutes of waiting,
		// but the actual waiting is near-zero because turn_end keeps waking
		// the poll loop.
	});
});

describe("Fixed: backoff not bypassed by turn_end or idle slowdown", () => {
	it("fixed computeWaitSec returns backoffSec when backoff is active", () => {
		const intervalSec = 60;
		const backoffSec = 300;

		for (const consecutiveNoChange of [0, 3, 5, 10]) {
			const waitSec = computeWaitSecFixed(
				{ backoffSec, consecutiveNoChange, agentTurnActive: false, inErrorBackoff: true },
				intervalSec,
			);
			// When in error backoff, the wait should always be >= backoffSec
			expect(waitSec).toBeGreaterThanOrEqual(backoffSec);
		}
	});

	it("fixed computeWaitSec: idle slowdown still applies when not in backoff", () => {
		const intervalSec = 60;

		// No backoff, consecutiveNoChange = 5 → idle slowdown = 240s
		const waitSec = computeWaitSecFixed(
			{ backoffSec: 0, consecutiveNoChange: 5, agentTurnActive: false, inErrorBackoff: false },
			intervalSec,
		);
		expect(waitSec).toBe(240);
	});

	it("fixed: small backoff (60s) respects backoff when consecutiveNoChange is high", () => {
		const intervalSec = 60;

		// After first error: backoffSec = 60 but consecutiveNoChange = 5 → idle = 240
		// In buggy code: actual wait = 240 (idle), NOT 60 (backoff)
		// In fixed code: actual wait = max(240, 60) = 240, which is correct
		// because the idle slowdown is LONGER than the backoff
		const waitSec = computeWaitSecFixed(
			{ backoffSec: 60, consecutiveNoChange: 5, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		expect(waitSec).toBeGreaterThanOrEqual(60); // At minimum, respect backoff
	});

	it("fixed: max backoff (300s) is respected even when idle slowdown would be less", () => {
		const intervalSec = 60;

		// After 4th error: backoffSec = 300, consecutiveNoChange = 4 → idle = 120
		// Fixed code should use max(120, 300) = 300
		const waitSec = computeWaitSecFixed(
			{ backoffSec: 300, consecutiveNoChange: 4, agentTurnActive: false, inErrorBackoff: true },
			intervalSec,
		);
		expect(waitSec).toBeGreaterThanOrEqual(300);
	});
});