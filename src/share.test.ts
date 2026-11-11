import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSession, getRunUrl } from "./share.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const entry = (model: unknown[]): EntryRecord =>
	({ id: 1, conversationId: 1, kind: "x", model }) as unknown as EntryRecord;

describe("getRunUrl", () => {
	it("links the workflow run when running in Actions", () => {
		expect(getRunUrl({ GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "5" })).toBe(
			"https://github.com/o/r/actions/runs/5",
		);
		expect(
			getRunUrl({
				GITHUB_SERVER_URL: "https://ghe.example",
				GITHUB_REPOSITORY: "o/r",
				GITHUB_RUN_ID: "5",
			}),
		).toBe("https://ghe.example/o/r/actions/runs/5");
		expect(getRunUrl({})).toBeUndefined();
	});
});

describe("exportSession", () => {
	it("writes a readable transcript and every entry", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "pi-share-")), "session");
		dirs.push(dir);
		const long = "y".repeat(5000);
		const entries = [
			entry([{ role: "user", content: "Please fix" }]),
			entry([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "text", text: "Running tests" },
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "npm test" },
						},
					],
				},
			]),
			entry([
				{
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: long }],
				},
			]),
			entry([{ role: "toolResult", content: [{ type: "text", text: "ok" }] }]),
			entry([{ role: "system", content: "ignored" }]),
			entry([{ role: "user", content: [{ type: "text", text: "Thanks" }] }]),
		];
		const url = await exportSession("Fix it", entries, {
			dir,
			runUrl: "https://run",
		});
		expect(url).toBe("https://run");
		const md = readFileSync(join(dir, "session.md"), "utf8");
		expect(md).toContain("# Fix it");
		expect(md).toContain("## 🧑 User\n\nPlease fix");
		expect(md).toContain('🔧 **bash** `{"command":"npm test"}`');
		expect(md).toContain("### Result of bash (error)");
		expect(md).toContain("… (1000 more characters)");
		expect(md).toContain("### Result of tool");
		expect(md).not.toContain("ignored");
		expect(md).toContain("Thanks");
		expect(
			readFileSync(join(dir, "session.jsonl"), "utf8").trim().split("\n"),
		).toHaveLength(6);
	});

	it("falls back to the directory without a run URL, and reports failures as undefined", async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-share-"));
		dirs.push(base);
		vi.stubEnv("GITHUB_REPOSITORY", "");
		expect(await exportSession("t", [], { dir: join(base, "a") })).toBe(
			join(base, "a"),
		);
		writeFileSync(join(base, "file"), "");
		expect(
			await exportSession("t", [], { dir: join(base, "file", "sub") }),
		).toBeUndefined();
	});
});
