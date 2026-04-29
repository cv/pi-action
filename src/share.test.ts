import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { GitHubClient } from "./github.js";
import { shareSession } from "./share.js";
import { createMockGitHubClient } from "./test-helpers.js";
import type { Session } from "./types.js";

describe("shareSession", () => {
	let mockGitHubClient: GitHubClient;
	let mockSession: Session;
	let tmpFile: string;

	beforeEach(() => {
		mockGitHubClient = createMockGitHubClient();
		tmpFile = join(tmpdir(), `test-session-${Date.now()}.html`);

		// Create mock session with exportToHtml method
		mockSession = {
			exportToHtml: vi.fn((path?: string) => {
				if (!path) {
					throw new Error("Missing output path");
				}
				writeFileSync(path, "<html>Mock session HTML</html>");
				return path;
			}),
		};

		vi.clearAllMocks();
	});

	afterEach(() => {
		// Clean up any leftover files
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore if file doesn't exist
		}
	});

	it("successfully shares session and returns preview URL", async () => {
		const gistUrl = "https://gist.github.com/user/abc123";
		(mockGitHubClient.createGist as Mock).mockResolvedValue(gistUrl);

		const result = await shareSession(
			mockSession,
			mockGitHubClient,
			"Test session",
		);

		expect(result).toEqual({
			gistUrl,
			previewUrl: "https://shittycodingagent.ai/session?abc123",
		});

		expect(mockSession.exportToHtml).toHaveBeenCalledWith(
			expect.stringMatching(/pi-session-\d+\.html$/),
		);
		expect(mockGitHubClient.createGist).toHaveBeenCalledWith(
			"<html>Mock session HTML</html>",
			"session.html",
			"Test session",
			false,
		);
	});

	it("uses default description when none provided", async () => {
		const gistUrl = "https://gist.github.com/user/def456";
		(mockGitHubClient.createGist as Mock).mockResolvedValue(gistUrl);

		await shareSession(mockSession, mockGitHubClient);

		expect(mockGitHubClient.createGist).toHaveBeenCalledWith(
			expect.any(String),
			"session.html",
			"pi-action session",
			false,
		);
	});

	it("returns null when session export fails", async () => {
		mockSession.exportToHtml = vi.fn(() => {
			throw new Error("Export failed");
		});

		const result = await shareSession(
			mockSession,
			mockGitHubClient,
			"Test session",
		);

		expect(result).toBeNull();
		expect(mockGitHubClient.createGist).not.toHaveBeenCalled();
	});

	it("returns null when gist creation fails", async () => {
		(mockGitHubClient.createGist as Mock).mockRejectedValue(
			new Error("Gist creation failed"),
		);

		const result = await shareSession(
			mockSession,
			mockGitHubClient,
			"Test session",
		);

		expect(result).toBeNull();
		expect(mockSession.exportToHtml).toHaveBeenCalled();
	});

	it("returns null when gist URL is invalid", async () => {
		(mockGitHubClient.createGist as Mock).mockResolvedValue("invalid-url");

		const result = await shareSession(
			mockSession,
			mockGitHubClient,
			"Test session",
		);

		expect(result).toBeNull();
	});

	it("cleans up temporary file even when sharing fails", async () => {
		mockSession.exportToHtml = vi.fn((path?: string) => {
			if (!path) {
				throw new Error("Missing output path");
			}
			writeFileSync(path, "test content");
			throw new Error("Export failed");
		});

		await shareSession(mockSession, mockGitHubClient, "Test session");

		// File should not exist after the function completes
		expect(() => unlinkSync(tmpFile)).toThrow();
	});
});
