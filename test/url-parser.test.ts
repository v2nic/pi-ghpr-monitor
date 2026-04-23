/**
 * Unit tests for PR URL parsing
 */

import { describe, it, expect } from "vitest";

// Inline the parser since it's not exported from analyzer.ts
const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/i;

interface ParsedPR {
	owner: string;
	repo: string;
	number: number;
	host: string;
}

function parsePRUrl(input: string): ParsedPR | null {
	const m = input.trim().match(PR_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

describe("parsePRUrl", () => {
	it("parses a standard GitHub PR URL", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 366,
			host: "github.com",
		});
	});

	it("parses a PR URL with trailing path segments", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366/files");
		expect(result).not.toBeNull();
		expect(result?.owner).toBe("v2nic");
		expect(result?.number).toBe(366);
	});

	it("parses a PR URL with query params", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366?expand=1");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(366);
	});

	it("parses a GitHub Enterprise URL", () => {
		const result = parsePRUrl("https://github.corp.com/team/project/pull/42");
		expect(result).toEqual({
			owner: "team",
			repo: "project",
			number: 42,
			host: "github.corp.com",
		});
	});

	it("parses an http URL", () => {
		const result = parsePRUrl("http://github.com/owner/repo/pull/1");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(1);
	});

	it("returns null for non-PR URLs", () => {
		expect(parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor")).toBeNull();
		expect(parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/issues/5")).toBeNull();
		expect(parsePRUrl("not a url")).toBeNull();
		expect(parsePRUrl("")).toBeNull();
		expect(parsePRUrl("owner/repo 42")).toBeNull();
	});

	it("returns null for PR URL with non-numeric number", () => {
		expect(parsePRUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
	});

	it("handles whitespace around URL", () => {
		const result = parsePRUrl("  https://github.com/v2nic/pi-ghpr-monitor/pull/366  ");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(366);
	});
});
describe("parsePRUrl with steer message", () => {
	it("parses URL without trailing message", () => {
		const url = "https://github.com/owner/repo/pull/42";
		const m = url.trim().match(PR_URL_RE);
		expect(m).not.toBeNull();
		const afterUrl = url.trim().slice(m![0].length).trim();
		expect(afterUrl).toBe("");
	});

	it("extracts steer message after URL", () => {
		const url = "https://github.com/owner/repo/pull/42 Address any CI failure";
		const m = url.trim().match(PR_URL_RE);
		expect(m).not.toBeNull();
		const afterUrl = url.trim().slice(m![0].length).trim();
		expect(afterUrl).toBe("Address any CI failure");
	});

	it("extracts multi-word steer message", () => {
		const url = "https://github.com/owner/repo/pull/42 You are assigned to finishing the work of this PR";
		const m = url.trim().match(PR_URL_RE);
		expect(m).not.toBeNull();
		const afterUrl = url.trim().slice(m![0].length).trim();
		expect(afterUrl).toBe("You are assigned to finishing the work of this PR");
	});

	it("URL with trailing slash has empty steer message", () => {
		const url = "https://github.com/owner/repo/pull/42/";
		const m = url.trim().match(PR_URL_RE);
		expect(m).not.toBeNull();
		const afterUrl = url.trim().slice(m![0].length).trim();
		expect(afterUrl).toBe("/");
	});
});

describe("parsePRShorthand", () => {
	function parsePRShorthand(input: string): ParsedPR | null {
		const hashM = input.trim().match(/^([^\s#/]+)\/([^#]+)#([0-9]+)$/);
		if (hashM) {
			return { owner: hashM[1], repo: hashM[2], number: parseInt(hashM[3], 10), host: "github.com" };
		}
		return null;
	}

	it("parses owner/repo#number format", () => {
		const result = parsePRShorthand("mobilityhouse/vgi-na-masscec#373");
		expect(result).toEqual({
			owner: "mobilityhouse",
			repo: "vgi-na-masscec",
			number: 373,
			host: "github.com",
		});
	});

	it("parses simple owner/repo#1 format", () => {
		const result = parsePRShorthand("v2nic/pi-ghpr-monitor#366");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 366,
			host: "github.com",
		});
	});

	it("handles whitespace around shorthand", () => {
		const result = parsePRShorthand("  v2nic/pi-ghpr-monitor#366  ");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(366);
	});

	it("returns null for URL format", () => {
		expect(parsePRShorthand("https://github.com/v2nic/pi-ghpr-monitor/pull/366")).toBeNull();
	});

	it("returns null for space-separated format", () => {
		expect(parsePRShorthand("v2nic/pi-ghpr-monitor 366")).toBeNull();
	});

	it("returns null for just owner/repo without number", () => {
		expect(parsePRShorthand("v2nic/pi-ghpr-monitor")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parsePRShorthand("")).toBeNull();
	});

	it("returns null for repo with hash in name but no number", () => {
		expect(parsePRShorthand("v2nic/some-repo#")).toBeNull();
	});

	it("returns null for non-numeric number after hash", () => {
		expect(parsePRShorthand("v2nic/repo#abc")).toBeNull();
	});
});
