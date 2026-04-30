import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shareSession } from "./share.js";
import type { Session } from "./types.js";

const SESSION_HTML_PATH_PATTERN = /session\.html$/u;
const SESSION_JSONL_PATH_PATTERN = /session\.jsonl$/u;

function createMockSession(): Session {
	return {
		exportToHtml: vi.fn((path?: string) => {
			if (!path) {
				throw new Error("Missing HTML output path");
			}
			writeFileSync(path, "<html>Mock session HTML</html>");
			return path;
		}),
		exportToJsonl: vi.fn((path?: string) => {
			if (!path) {
				throw new Error("Missing JSONL output path");
			}
			writeFileSync(path, '{"type":"session"}\n');
			return path;
		}),
	};
}

const artifactDirs: string[] = [];

function createArtifactDir(name: string): string {
	const artifactDir = join(tmpdir(), `${name}-${Date.now()}`);
	artifactDirs.push(artifactDir);
	return artifactDir;
}

describe("shareSession", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const artifactDir of artifactDirs.splice(0)) {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("exports HTML and JSONL session files for artifact upload", async () => {
		const artifactDir = createArtifactDir("pi-session-test");
		const session = createMockSession();

		const result = await shareSession(session, {
			artifactName: "pi-session-test",
			artifactDir,
			runUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});

		expect(result).toEqual({
			artifactName: "pi-session-test",
			artifactDir,
			artifactUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});
		expect(session.exportToHtml).toHaveBeenCalledWith(
			expect.stringMatching(SESSION_HTML_PATH_PATTERN),
		);
		expect(session.exportToJsonl).toHaveBeenCalledWith(
			expect.stringMatching(SESSION_JSONL_PATH_PATTERN),
		);
		expect(readFileSync(join(artifactDir, "session.html"), "utf-8")).toBe(
			"<html>Mock session HTML</html>",
		);
		expect(readFileSync(join(artifactDir, "session.jsonl"), "utf-8")).toBe(
			'{"type":"session"}\n',
		);
	});

	it("falls back to the artifact directory when no run URL is available", async () => {
		vi.stubEnv("GITHUB_REPOSITORY", "");
		vi.stubEnv("GITHUB_RUN_ID", "");
		const artifactDir = createArtifactDir("pi-session-test");

		const result = await shareSession(createMockSession(), {
			artifactName: "pi-session-test",
			artifactDir,
		});

		expect(result).toEqual({
			artifactName: "pi-session-test",
			artifactDir,
			artifactUrl: artifactDir,
		});
	});

	it("returns null when HTML export fails and cleans up temp files", async () => {
		const artifactDir = createArtifactDir("pi-session-test");
		const session = createMockSession();
		session.exportToHtml = vi.fn(() => {
			throw new Error("Export failed");
		});

		const result = await shareSession(session, {
			artifactName: "pi-session-test",
			artifactDir,
		});

		expect(result).toBeNull();
		expect(existsSync(artifactDir)).toBe(false);
	});

	it("returns null when JSONL export fails and cleans up temp files", async () => {
		const artifactDir = createArtifactDir("pi-session-test");
		const session = createMockSession();
		session.exportToJsonl = vi.fn(() => {
			throw new Error("Export failed");
		});

		const result = await shareSession(session, {
			artifactName: "pi-session-test",
			artifactDir,
		});

		expect(result).toBeNull();
		expect(existsSync(artifactDir)).toBe(false);
	});
});
