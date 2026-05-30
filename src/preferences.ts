/**
 * Preferences module for pi-ghpr-monitor
 *
 * Stores customizable prompt overrides in
 * ~/.config/pi-ghpr-monitor/preferences.json
 *
 * Each preference is an optional string template that can reference
 * template variables. When a preference is set, it replaces the
 * hardcoded default message for that situation. When not set, the
 * default is used.
 *
 * Template variables available in all preferences:
 *   {owner}, {repo}, {number}, {host}, {prLabel}
 *
 * Additional situation-specific variables:
 *   newComments:  {unresolvedThreads}, {generalComments}
 *   conflict:     (none extra)
 *   ciFailure:    {failingChecks}
 *   reminder:     {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}
 *   allClear:     (none extra)
 *   firstPoll:    {intervalSec}
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

export const PreferencesSchema = Type.Object(
	{
		newComments: Type.Optional(
			Type.String({
				description:
					"Prompt override for new review comments / unresolved threads. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {unresolvedThreads}, {generalComments}",
			}),
		),
		conflict: Type.Optional(
			Type.String({
				description:
					"Prompt override for merge conflicts. Variables: {owner}, {repo}, {number}, {host}, {prLabel}",
			}),
		),
		ciFailure: Type.Optional(
			Type.String({
				description:
					"Prompt override for CI failures. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {failingChecks}",
			}),
		),
		reminder: Type.Optional(
			Type.String({
				description:
					"Prompt override for periodic reminders. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}",
			}),
		),
		allClear: Type.Optional(
			Type.String({
				description:
					"Prompt override for all-clear status. Variables: {owner}, {repo}, {number}, {host}, {prLabel}",
			}),
		),
		firstPoll: Type.Optional(
			Type.String({
				description:
					"Prompt override for the initial status on first poll. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {intervalSec}",
			}),
		),
	},
	{
		additionalProperties: false,
	},
);

export type Preferences = Static<typeof PreferencesSchema>;

/** Allowed preference keys for validation error messages */
const ALLOWED_KEYS = new Set(Object.keys(PreferencesSchema.properties));

// ---------------------------------------------------------------------------
// Preference file path
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".config", "pi-ghpr-monitor");
const PREFERENCES_FILE = path.join(CONFIG_DIR, "preferences.json");

/**
 * Override the preferences file path (for testing).
 * When set, loadPreferences/savePreferences use this path instead
 * of the default ~/.config/pi-ghpr-monitor/preferences.json.
 */
let preferencesPathOverride: string | undefined;

/**
 * Set a custom preferences file path. Used in tests to avoid writing
 * to the real config directory.
 */
export function setPreferencesPath(overridePath: string | undefined): void {
	preferencesPathOverride = overridePath;
}

function getEffectiveFilePath(): string {
	return preferencesPathOverride ?? PREFERENCES_FILE;
}

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

export interface TemplateVars {
	owner: string;
	repo: string;
	number: number;
	host: string;
	prLabel: string;
	// Situation-specific (may be undefined depending on context)
	unresolvedThreads?: number;
	generalComments?: number;
	failingChecks?: string;
	conflict?: boolean;
	intervalSec?: number;
}

const TEMPLATE_VAR_RE = /\{(owner|repo|number|host|prLabel|unresolvedThreads|generalComments|failingChecks|conflict|intervalSec)\}/g;

/**
 * Replace template placeholders with actual values.
 * Unknown placeholders are left as-is.
 */
export function interpolateTemplate(template: string, vars: TemplateVars): string {
	return template.replace(TEMPLATE_VAR_RE, (match, key: string) => {
		switch (key) {
			case "owner":
				return vars.owner;
			case "repo":
				return vars.repo;
			case "number":
				return String(vars.number);
			case "host":
				return vars.host;
			case "prLabel":
				return vars.prLabel;
			case "unresolvedThreads":
				return vars.unresolvedThreads !== undefined ? String(vars.unresolvedThreads) : match;
			case "generalComments":
				return vars.generalComments !== undefined ? String(vars.generalComments) : match;
			case "failingChecks":
				return vars.failingChecks ?? match;
			case "conflict":
				return vars.conflict !== undefined ? String(vars.conflict) : match;
			case "intervalSec":
				return vars.intervalSec !== undefined ? String(vars.intervalSec) : match;
			default:
				return match;
		}
	});
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	preferences?: Preferences;
}

/**
 * Validate a JSON string against the PreferencesSchema.
 * Returns a structured result with errors if invalid.
 */
export function validatePreferences(jsonString: string): ValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonString);
	} catch (e) {
		return {
			ok: false,
			errors: [`Invalid JSON: ${(e as Error).message}`],
		};
	}

	// Check for extra keys not in the schema
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const parsedObj = parsed as Record<string, unknown>;
		const extraKeys = Object.keys(parsedObj).filter((k) => !ALLOWED_KEYS.has(k));
		if (extraKeys.length > 0) {
			return {
				ok: false,
				errors: [
					`Unknown preference keys: ${extraKeys.join(", ")}. Allowed keys: ${[...ALLOWED_KEYS].join(", ")}`,
				],
			};
		}
	}

	// Use TypeBox Value.Check for structural validation
	if (!Value.Check(PreferencesSchema, parsed)) {
		const errors: string[] = [];
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return {
				ok: false,
				errors: ["Preferences must be a JSON object with optional string values."],
			};
		}

		const parsedObj = parsed as Record<string, unknown>;
		for (const [key, value] of Object.entries(parsedObj)) {
			if (value !== undefined && typeof value !== "string") {
				errors.push(`Expected string for '${key}', got ${typeof value}`);
			}
		}

		if (errors.length === 0) {
			errors.push("Preferences validation failed. Check that all values are strings.");
		}

		return { ok: false, errors };
	}

	return {
		ok: true,
		errors: [],
		preferences: parsed as Preferences,
	};
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load preferences from disk. Returns an empty object if the file does not
 * exist or cannot be read. Logs warnings on errors.
 * Uses the override path if set via setPreferencesPath().
 */
export function loadPreferences(): Preferences {
	const filePath = getEffectiveFilePath();
	try {
		if (!fs.existsSync(filePath)) {
			log("No preferences file found, using defaults");
			return {};
		}
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!Value.Check(PreferencesSchema, parsed)) {
			log("Preferences file is invalid, using defaults");
			return {};
		}
		return parsed as Preferences;
	} catch (err) {
		log(`Error loading preferences: ${(err as Error).message}`);
		return {};
	}
}

/**
 * Save preferences to disk. Creates the config directory if it doesn't exist.
 * Writes atomically via a temp file and rename.
 * Uses the override path if set via setPreferencesPath().
 */
export function savePreferences(prefs: Preferences): void {
	const filePath = getEffectiveFilePath();
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = filePath + ".tmp";
	fs.writeFileSync(tmpFile, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
	fs.renameSync(tmpFile, filePath);
	log(`Preferences saved to ${filePath}`);
}

/**
 * Get the path to the preferences file (useful for tests and display).
 * Returns the override path if set, otherwise the default path.
 */
export function getPreferencesPath(): string {
	return getEffectiveFilePath();
}

// ---------------------------------------------------------------------------
// Preference lookup with fallback
// ---------------------------------------------------------------------------

/**
 * Look up a preference for a given situation key. If set, interpolate
 * template variables. If not set, return the default value.
 */
export function getPreferenceWithDefault(
	key: keyof Preferences,
	prefs: Preferences,
	vars: TemplateVars,
	defaultValue: string,
): string {
	const template = prefs[key];
	if (template !== undefined && template !== "") {
		return interpolateTemplate(template, vars);
	}
	return defaultValue;
}