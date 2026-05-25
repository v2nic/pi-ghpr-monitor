/**
 * Tests for source file validity — catches corruption issues that prevent
 * the extension from loading at runtime.
 *
 * These tests verify that the TypeScript source file does not contain
 * syntax errors that would prevent the Pi runtime from parsing it, such
 * as escaped template literal backticks or interpolation markers that
 * should be raw characters.
 *
 * The bug: a merge commit introduced escaped template literal characters
 * into src/index.ts. The line had literal backslash-backtick and
 * backslash-dollar-brace instead of raw backtick and dollar-brace.
 * This caused a ParseError when the Pi runtime loaded the extension.
 *
 * These tests track lexical context (strings, comments, template literals)
 * to avoid false positives for valid escape sequences like \` inside
 * template strings or \${ to escape interpolation inside template literals.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

/**
 * A simple tokenizer that tracks whether a character position is inside
 * a string literal, comment, or template literal. This avoids false
 * positives where valid escape sequences (like \` inside a template
 * literal) are flagged as errors.
 */
function classifyContext(source: string, offset: number): "code" | "string" | "comment" | "template" | "regex" {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inTemplate = false;
	let templateDepth = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inRegex = false;
	let i = 0;

	while (i < offset && i < source.length) {
		const ch = source[i];
		const next = i + 1 < source.length ? source[i + 1] : "";

		// Line comments
		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
			}
			i++;
			continue;
		}

		// Block comments
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		// Start of comment
		if (ch === "/" && next === "/") {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i += 2;
			continue;
		}

		// Inside template literal (with nesting for ${} expressions)
		if (inTemplate) {
			if (ch === "$" && next === "{") {
				templateDepth++;
				i += 2;
				continue;
			}
			if (ch === "}" && templateDepth > 0) {
				templateDepth--;
				i++;
				continue;
			}
			if (ch === "`") {
				if (templateDepth === 0) {
					inTemplate = false;
				}
				i++;
				continue;
			}
			// Escaped characters inside template literal are valid
			if (ch === "\\") {
				i += 2; // skip the escaped character
				continue;
			}
			i++;
			continue;
		}

		// Start of template literal
		if (ch === "`") {
			inTemplate = true;
			i++;
			continue;
		}

		// Inside single-quoted string
		if (inSingleQuote) {
			if (ch === "\\") {
				i += 2; // skip escaped char
				continue;
			}
			if (ch === "'") {
				inSingleQuote = false;
			}
			i++;
			continue;
		}

		// Inside double-quoted string
		if (inDoubleQuote) {
			if (ch === "\\") {
				i += 2; // skip escaped char
				continue;
			}
			if (ch === '"') {
				inDoubleQuote = false;
			}
			i++;
			continue;
		}

		// Start of string
		if (ch === "'") {
			inSingleQuote = true;
			i++;
			continue;
		}
		if (ch === '"') {
			inDoubleQuote = true;
			i++;
			continue;
		}

		i++;
	}

	if (inLineComment || inBlockComment) return "comment";
	if (inSingleQuote || inDoubleQuote) return "string";
	if (inTemplate) return "template";
	return "code";
}

describe("Source file has no escaped template literal characters", () => {
	it("contains no literal backslash-backtick in code context", () => {
		// The byte sequence 0x5c 0x60 (backslash + backtick) outside of
		// strings, comments, and template literals creates an invalid
		// escape sequence that causes:
		//   ParseError: Expecting Unicode escape sequence \uXXXX
		//
		// Inside a template literal, \` is valid (escapes a literal backtick).
		// Inside a single/double-quoted string, \` is also valid.
		// Only in code context is \` invalid.
		const errors: string[] = [];

		for (let i = 0; i < src.length - 1; i++) {
			if (src.charCodeAt(i) === 0x5c && src.charCodeAt(i + 1) === 0x60) {
				const ctx = classifyContext(src, i);
				if (ctx === "code") {
					// Find line number for context
					const lineStart = src.lastIndexOf("\n", i) + 1;
					const lineEnd = src.indexOf("\n", i);
					const lineNum = src.substring(0, i).split("\n").length;
					const context = src.substring(Math.max(lineStart, i - 20), Math.min(lineEnd === -1 ? src.length : lineEnd, i + 20));
					errors.push(
						"Line " + lineNum + ", col " + (i - lineStart + 1) +
						": found escaped backtick (0x5c 0x60) in code context." +
						" This causes ParseError. Context: ..." + context + "..."
					);
				}
			}
		}

		if (errors.length > 0) {
			throw new Error("Found escaped backticks in code context:\n" + errors.join("\n"));
		}
	});

	it("contains no literal backslash-dollar-brace in code context", () => {
		// The byte sequence 0x5c 0x24 0x7b (backslash + dollar + open-brace)
		// outside of strings, comments, and template literals creates a broken
		// template interpolation marker.
		//
		// Inside a template literal, \${ is valid (escapes interpolation).
		// In code context, \${ is invalid.
		const errors: string[] = [];

		for (let i = 0; i < src.length - 2; i++) {
			if (src.charCodeAt(i) === 0x5c && src.charCodeAt(i + 1) === 0x24 && src.charCodeAt(i + 2) === 0x7b) {
				const ctx = classifyContext(src, i);
				if (ctx === "code") {
					const lineStart = src.lastIndexOf("\n", i) + 1;
					const lineEnd = src.indexOf("\n", i);
					const lineNum = src.substring(0, i).split("\n").length;
					const context = src.substring(Math.max(lineStart, i - 20), Math.min(lineEnd === -1 ? src.length : lineEnd, i + 25));
					errors.push(
						"Line " + lineNum + ", col " + (i - lineStart + 1) +
						": found escaped dollar-brace (0x5c 0x24 0x7b) in code context." +
						" This breaks template interpolation. Context: ..." + context + "..."
					);
				}
			}
		}

		if (errors.length > 0) {
			throw new Error("Found escaped dollar-brace in code context:\n" + errors.join("\n"));
		}
	});

	it("has valid template literal syntax (backticks are properly paired)", () => {
		// Verify that the source file can be parsed as JavaScript by checking
		// that backticks come in pairs (for template literals), using the
		// same context tracker to ignore backticks inside strings and comments.
		let inTemplate = false;
		let templateStartLine = 1;
		let templateStartCol = 1;

		for (let i = 0; i < src.length; i++) {
			const ctx = classifyContext(src, i);

			if (ctx === "string" || ctx === "comment") continue;

			if (src[i] === "`") {
				// Check if this backtick is escaped (preceded by \ that's not itself escaped)
				const isEscaped = i > 0 && src[i - 1] === "\\" && (i < 2 || src[i - 2] !== "\\");
				if (isEscaped) continue;

				if (!inTemplate) {
					inTemplate = true;
					templateStartLine = src.substring(0, i).split("\n").length;
					templateStartCol = i - src.lastIndexOf("\n", i);
				} else {
					inTemplate = false;
				}
			}
		}

		if (inTemplate) {
			throw new Error(
				"Unclosed template literal starting at line " + templateStartLine +
				", col " + templateStartCol + ". This would cause a ParseError."
			);
		}
	});
});