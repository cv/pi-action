import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { shareSession } from "./share.js";
import type { Session } from "./types.js";

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

describe("shareSession", () => {
	it("uploads HTML and JSONL session exports as an artifact", async () => {
		const artifactClient = {
			uploadArtifact: vi.fn().mockResolvedValue({ id: 123 }),
		};
		const session = createMockSession();

		const result = await shareSession(session, {
			artifactName: "pi-session-test",
			artifactClient,
			runUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});

		expect(result).toEqual({
			artifactName: "pi-session-test",
			artifactId: 123,
			artifactUrl:
				"https://github.com/cv/pi-action/actions/runs/1/artifacts/123",
		});
		expect(session.exportToHtml).toHaveBeenCalledWith(
			expect.stringMatching(/session\.html$/),
		);
		expect(session.exportToJsonl).toHaveBeenCalledWith(
			expect.stringMatching(/session\.jsonl$/),
		);
		expect(artifactClient.uploadArtifact).toHaveBeenCalledWith(
			"pi-session-test",
			[
				expect.stringMatching(/session\.html$/),
				expect.stringMatching(/session\.jsonl$/),
			],
			expect.stringContaining("pi-session-test-"),
		);
	});

	it("falls back to the run URL when artifact id is absent", async () => {
		const artifactClient = {
			uploadArtifact: vi.fn().mockResolvedValue({}),
		};

		const result = await shareSession(createMockSession(), {
			artifactName: "pi-session-test",
			artifactClient,
			runUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});

		expect(result).toEqual({
			artifactName: "pi-session-test",
			artifactUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});
	});

	it("returns null when session export fails", async () => {
		const artifactClient = {
			uploadArtifact: vi.fn(),
		};
		const session = createMockSession();
		session.exportToHtml = vi.fn(() => {
			throw new Error("Export failed");
		});

		const result = await shareSession(session, {
			artifactName: "pi-session-test",
			artifactClient,
		});

		expect(result).toBeNull();
		expect(artifactClient.uploadArtifact).not.toHaveBeenCalled();
	});

	it("returns null when artifact upload fails and cleans up temp files", async () => {
		const artifactClient = {
			uploadArtifact: vi.fn().mockRejectedValue(new Error("Upload failed")),
		};
		let artifactRoot = "";
		artifactClient.uploadArtifact.mockImplementationOnce(
			async (_name: string, files: string[], rootDirectory: string) => {
				artifactRoot = rootDirectory;
				expect(files.every((file) => existsSync(file))).toBe(true);
				throw new Error("Upload failed");
			},
		);

		const result = await shareSession(createMockSession(), {
			artifactName: "pi-session-test",
			artifactClient,
		});

		expect(result).toBeNull();
		expect(artifactRoot).not.toBe("");
		expect(existsSync(artifactRoot)).toBe(false);
	});
});
