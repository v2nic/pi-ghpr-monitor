/**
 * Tests for the preferences module
 *
 * Tests schema validation, load/save, template interpolation,
 * and preference lookup with fallback to defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	PreferencesSchema,
	validatePreferences,
	loadPreferences,
	savePreferences,
	getPreferencesPath,
	setPreferencesPath,
	interpolateTemplate,
	getPreferenceWithDefault,
	type Preferences,
	type TemplateVars,
} from "../src/preferences";

// ---------------------------------------------------------------------------
// Helper: create a temp dir for preferences testing
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalPath: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghpr-prefs-test-"));
	setPreferencesPath(undefined); // Reset first
});

afterEach(() => {
	// Clean up temp dir and reset preferences path
	fs.rmSync(tmpDir, { recursive: true, force: true });
	setPreferencesPath(undefined);
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("validatePreferences", () => {
	it("accepts an empty object", () => {
		const result = validatePreferences("{}");
		expect(result.ok).toBe(true);
		expect(result.preferences).toEqual({});
	});

	it("accepts valid partial preferences", () => {
		const result = validatePreferences('{"conflict": "⚠️ Conflict on {prLabel}!"}');
		expect(result.ok).toBe(true);
		expect(result.preferences).toEqual({
			conflict: "⚠️ Conflict on {prLabel}!",
		});
	});

	it("accepts all valid preference keys", () => {
		const json = JSON.stringify({
			newComments: "New comments on {prLabel}",
			conflict: "Conflict on {prLabel}",
			ciFailure: "CI failing on {prLabel}",
			reminder: "Still issues on {prLabel}",
			allClear: "All clear on {prLabel}",
			firstPoll: "Monitoring {prLabel}...",
		});
		const result = validatePreferences(json);
		expect(result.ok).toBe(true);
		expect(Object.keys(result.preferences!)).toHaveLength(6);
	});

	it("rejects invalid JSON", () => {
		const result = validatePreferences("not json");
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Invalid JSON");
	});

	it("rejects unknown preference keys", () => {
		const result = validatePreferences('{"unknownKey": "value"}');
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Unknown preference keys");
		expect(result.errors[0]).toContain("unknownKey");
	});

	it("rejects non-string values", () => {
		const result = validatePreferences('{"conflict": 123}');
		expect(result.ok).toBe(false);
		expect(result.errors.some((e: string) => e.includes("Expected string"))).toBe(true);
	});

	it("rejects array value", () => {
		const result = validatePreferences('["conflict"]');
		expect(result.ok).toBe(false);
	});

	it("rejects null value for a key", () => {
		const result = validatePreferences('{"conflict": null}');
		expect(result.ok).toBe(false);
	});

	it("accepts empty string values", () => {
		const result = validatePreferences('{"conflict": ""}');
		expect(result.ok).toBe(true);
		expect(result.preferences!.conflict).toBe("");
	});

	it("allows valid keys alongside invalid ones", () => {
		// Extra keys should be rejected, but valid keys should pass
		const result = validatePreferences('{"conflict": "foo", "bogus": "bar"}');
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("bogus");
	});
});

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

describe("interpolateTemplate", () => {
	const vars: TemplateVars = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 32,
		host: "github.com",
		prLabel: "v2nic/pi-ghpr-monitor#32",
	};

	it("replaces all basic template variables", () => {
		const result = interpolateTemplate("{owner}/{repo}#{number} on {host}", vars);
		expect(result).toBe("v2nic/pi-ghpr-monitor#32 on github.com");
	});

	it("replaces prLabel", () => {
		const result = interpolateTemplate("PR: {prLabel}", vars);
		expect(result).toBe("PR: v2nic/pi-ghpr-monitor#32");
	});

	it("replaces situation-specific variables when provided", () => {
		const result = interpolateTemplate("{unresolvedThreads} threads, {generalComments} comments, {failingChecks} failures", {
			...vars,
			unresolvedThreads: 3,
			generalComments: 2,
			failingChecks: "ci/test, ci/build",
		});
		expect(result).toBe("3 threads, 2 comments, ci/test, ci/build failures");
	});

	it("leaves unknown placeholders intact", () => {
		const result = interpolateTemplate("Hello {unknown} {owner}", vars);
		expect(result).toBe("Hello {unknown} v2nic");
	});

	it("leaves situation-specific placeholders intact when not provided", () => {
		const result = interpolateTemplate("{unresolvedThreads} threads on {prLabel}", vars);
		expect(result).toBe("{unresolvedThreads} threads on v2nic/pi-ghpr-monitor#32");
	});

	it("handles conflict variable", () => {
		const result = interpolateTemplate("Conflict: {conflict}", {
			...vars,
			conflict: true,
		});
		expect(result).toBe("Conflict: true");
	});

	it("handles empty template", () => {
		const result = interpolateTemplate("", vars);
		expect(result).toBe("");
	});

	it("handles template with no variables", () => {
		const result = interpolateTemplate("No variables here", vars);
		expect(result).toBe("No variables here");
	});
});

// ---------------------------------------------------------------------------
// Preference lookup with fallback
// ---------------------------------------------------------------------------

describe("getPreferenceWithDefault", () => {
	const vars: TemplateVars = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 32,
		host: "github.com",
		prLabel: "v2nic/pi-ghpr-monitor#32",
	};

	it("returns default when preference is undefined", () => {
		const result = getPreferenceWithDefault("conflict", {}, vars, "default conflict message");
		expect(result).toBe("default conflict message");
	});

	it("returns default when preference is empty string", () => {
		const result = getPreferenceWithDefault("conflict", { conflict: "" }, vars, "default conflict message");
		expect(result).toBe("default conflict message");
	});

	it("returns interpolated preference when set", () => {
		const result = getPreferenceWithDefault("conflict", { conflict: "⚠️ Conflict on {prLabel}!" }, vars, "default");
		expect(result).toBe("⚠️ Conflict on v2nic/pi-ghpr-monitor#32!");
	});

	it("interpolates situation-specific variables", () => {
		const result = getPreferenceWithDefault("newComments", { newComments: "{unresolvedThreads} threads on {prLabel}" }, {
			...vars,
			unresolvedThreads: 5,
		}, "default");
		expect(result).toBe("5 threads on v2nic/pi-ghpr-monitor#32");
	});
});

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

describe("loadPreferences / savePreferences", () => {
	it("returns empty object when file does not exist", () => {
		const prefsPath = path.join(tmpDir, "test1.json");
		setPreferencesPath(prefsPath);
		const prefs = loadPreferences();
		expect(prefs).toEqual({});
	});

	it("saves and loads preferences round-trip", () => {
		const prefsPath = path.join(tmpDir, "test2.json");
		setPreferencesPath(prefsPath);
		const prefs: Preferences = {
			conflict: "⚠️ Conflict on {prLabel}!",
			ciFailure: "CI failing: {failingChecks}",
		};
		savePreferences(prefs);

		const loaded = loadPreferences();
		expect(loaded).toEqual(prefs);
	});

	it("persists preferences to disk", () => {
		const prefsPath = path.join(tmpDir, "test3.json");
		setPreferencesPath(prefsPath);
		savePreferences({ allClear: "✨ {prLabel} all clear!" });

		expect(fs.existsSync(prefsPath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
		expect(raw.allClear).toBe("✨ {prLabel} all clear!");
	});

	it("ignores invalid preferences file on load", () => {
		const prefsPath = path.join(tmpDir, "test4.json");
		setPreferencesPath(prefsPath);
		fs.writeFileSync(prefsPath, "not json", "utf-8");

		const prefs = loadPreferences();
		expect(prefs).toEqual({});
	});

	it("ignores preferences with wrong schema on load", () => {
		const prefsPath = path.join(tmpDir, "test5.json");
		setPreferencesPath(prefsPath);
		fs.writeFileSync(prefsPath, JSON.stringify({ unknownKey: "value" }), "utf-8");

		const prefs = loadPreferences();
		expect(prefs).toEqual({});
	});

	it("replaces entire preferences file on save", () => {
		const prefsPath = path.join(tmpDir, "test6.json");
		setPreferencesPath(prefsPath);
		savePreferences({ conflict: "first" });
		savePreferences({ ciFailure: "second" });

		const loaded = loadPreferences();
		expect(loaded).toEqual({ ciFailure: "second" });
		// conflict should NOT be present since save replaces the whole file
		expect("conflict" in loaded).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Integration: preferences override notification formatting
// ---------------------------------------------------------------------------

describe("preferences in notification formatting", () => {
	const config = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 32,
		host: "github.com",
		mode: "all" as const,
		intervalSec: 60,
		debounceSec: 30,
	};

	const cleanStatus = {
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: [] as string[],
		pendingChecks: [] as string[],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
		threadDetails: [] as unknown[],
		commentDetails: [] as unknown[],
		checkDetails: [] as unknown[],
	};

	it("formatActionableItems uses preference for conflict", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = { ...cleanStatus, hasConflicts: true };
		const prefs: Preferences = { conflict: "🚨 MERGE CONFLICT on {prLabel}!" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toContain("🚨 MERGE CONFLICT on v2nic/pi-ghpr-monitor#32!");
		expect(result).not.toContain("Merge conflicts detected");
	});

	it("formatActionableItems uses preference for ciFailure", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = { ...cleanStatus, failingChecks: ["ci/test"] };
		const prefs: Preferences = { ciFailure: "💥 CI FAILED: {failingChecks}" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toContain("💥 CI FAILED: ci/test");
		expect(result).not.toContain("Failing CI checks");
	});

	it("formatActionableItems uses preference for newComments (threads)", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = {
			...cleanStatus,
			unresolvedThreads: 3,
			threadDetails: [
				{ id: "t1", isResolved: false, lastCommentAuthor: "user", lastCommentBody: "fix this" },
			],
		};
		const prefs: Preferences = { newComments: "📬 {unresolvedThreads} threads need review on {prLabel}" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toContain("📬 3 threads need review on v2nic/pi-ghpr-monitor#32");
	});

	it("formatActionableItems uses preference for reminder (overrides all)", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = {
			...cleanStatus,
			hasConflicts: true,
			unresolvedThreads: 2,
			generalComments: 1,
			failingChecks: ["ci/test"],
			threadDetails: [
				{ id: "t1", isResolved: false, lastCommentAuthor: "user", lastCommentBody: "fix this" },
			],
			commentDetails: [
				{ id: "c1", author: "user", body: "comment" },
			],
			checkDetails: [
				{ name: "ci/test", conclusion: "FAILURE" },
			],
		};
		const prefs: Preferences = { reminder: "⏰ Reminder: {prLabel} needs attention ({unresolvedThreads} threads, {generalComments} comments)" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toBe("⏰ Reminder: v2nic/pi-ghpr-monitor#32 needs attention (2 threads, 1 comments)");
		// When reminder is set, it replaces the entire concise summary
		expect(result).not.toContain("Merge conflicts detected");
		expect(result).not.toContain("Failing CI");
	});

	it("formatActionableItems uses default when no preferences set", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = { ...cleanStatus, hasConflicts: true };

		const result = formatActionableItems(status, config, {});
		expect(result).toContain("Merge conflicts detected on v2nic/pi-ghpr-monitor#32");
	});

	it("formatStatusUpdate uses preference for allClear", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { allClear: "🎉 {prLabel} is all good!" };
		const prev = {
			...cleanStatus,
			hasConflicts: true,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"] as string[],
		};
		const curr = { ...cleanStatus };

		const result = formatStatusUpdate(prev, curr, config, prefs);
		expect(result).toContain("🎉 v2nic/pi-ghpr-monitor#32 is all good!");
		expect(result).not.toContain("no issues, all clear");
	});

	it("formatStatusUpdate uses preference for conflict", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { conflict: "🚨 CONFLICT on {prLabel}!" };
		const curr = { ...cleanStatus, hasConflicts: true };

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("🚨 CONFLICT on v2nic/pi-ghpr-monitor#32!");
		expect(result).not.toContain("Merge conflicts detected");
	});

	it("formatStatusUpdate uses preference for ciFailure", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { ciFailure: "💥 CI failing on {prLabel}: {failingChecks}" };
		const curr = {
			...cleanStatus,
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		};

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("💥 CI failing on v2nic/pi-ghpr-monitor#32: ci/test");
		expect(result).not.toContain("Failing CI checks");
	});

	it("formatStatusUpdate uses preference for newComments with threads", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { newComments: "📬 {unresolvedThreads} threads on {prLabel}" };
		const curr = {
			...cleanStatus,
			unresolvedThreads: 3,
			threadDetails: [
				{ id: "t1", isResolved: false, lastCommentAuthor: "user", lastCommentBody: "fix this" },
			],
		};

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("📬 3 threads on v2nic/pi-ghpr-monitor#32");
	});

	it("formatStatusUpdate uses preference for newComments with general comments", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { newComments: "📬 {generalComments} comments on {prLabel}" };
		const curr = {
			...cleanStatus,
			generalComments: 2,
			commentDetails: [
				{ id: "c1", author: "user", body: "comment" },
			],
		};

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("📬 2 comments on v2nic/pi-ghpr-monitor#32");
	});

	it("formatStatusUpdate with no preferences uses defaults", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const curr = { ...cleanStatus, hasConflicts: true };

		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("Merge conflicts detected on v2nic/pi-ghpr-monitor#32");
	});
});