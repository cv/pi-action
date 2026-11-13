import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadSystemPromptFiles,
	type SystemPromptFilesOptions,
} from "./system-prompt-files.ts";
import { createLogger, tempDir } from "./test-helpers.ts";

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function options(
	overrides: Partial<SystemPromptFilesOptions> & { cwd: string },
): SystemPromptFilesOptions {
	return {
		workspace: undefined,
		agentDir: undefined,
		trustProject: true,
		fork: false,
		maxBytes: 65_536,
		log: createLogger(),
		...overrides,
	};
}

/** A project with both files in .pi, and an agent_dir outside it with both files too. */
function setUp(): { cwd: string; agentDir: string } {
	const cwd = tempDir();
	const agentDir = tempDir();
	write(join(cwd, ".pi", "SYSTEM.md"), "Project system.\n");
	write(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Project append.");
	write(join(agentDir, "SYSTEM.md"), "User system.");
	write(join(agentDir, "APPEND_SYSTEM.md"), "User append.");
	return { cwd, agentDir };
}

describe("loadSystemPromptFiles", () => {
	it("reads the trusted project's files first, and logs them", async () => {
		const { cwd, agentDir } = setUp();
		const log = createLogger();
		const files = await loadSystemPromptFiles(
			options({ cwd, agentDir, log }),
		);
		expect(files).toStrictEqual({
			system: { label: ".pi/SYSTEM.md", content: "Project system." },
			append: { label: ".pi/APPEND_SYSTEM.md", content: "Project append." },
		});
		expect(log.info).toHaveBeenCalledWith(
			"System prompt: .pi/SYSTEM.md (15 B, replaces pi's base prompt)",
		);
		expect(log.info).toHaveBeenCalledWith(
			"System prompt: appended .pi/APPEND_SYSTEM.md (15 B)",
		);
	});

	it("falls back to agent_dir for each file the project doesn't have", async () => {
		const { cwd, agentDir } = setUp();
		write(join(cwd, ".pi", "APPEND_SYSTEM.md"), "\uFEFF \n");
		const files = await loadSystemPromptFiles(options({ cwd, agentDir }));
		expect(files.system?.label).toBe(".pi/SYSTEM.md");
		expect(files.append).toStrictEqual({
			label: "agent_dir/APPEND_SYSTEM.md",
			content: "User append.",
		});
	});

	it("skips the project's files without trust_project, with a log line", async () => {
		const { cwd, agentDir } = setUp();
		const log = createLogger();
		const files = await loadSystemPromptFiles(
			options({ cwd, agentDir, trustProject: false, log }),
		);
		expect(files.system?.label).toBe("agent_dir/SYSTEM.md");
		expect(files.append?.label).toBe("agent_dir/APPEND_SYSTEM.md");
		expect(log.info).toHaveBeenCalledWith(
			"System prompt: not loading .pi/SYSTEM.md: trust_project is off",
		);
	});

	it("skips the project's files on a pull request from a fork, and agent_dir's in the checkout", async () => {
		const { cwd, agentDir } = setUp();
		const inside = join(cwd, "agent");
		write(join(inside, "SYSTEM.md"), "Fork system.");
		const log = createLogger();
		const outside = await loadSystemPromptFiles(
			options({ cwd, agentDir, fork: true, log }),
		);
		expect(outside.system?.label).toBe("agent_dir/SYSTEM.md");
		expect(log.info).toHaveBeenCalledWith(
			"System prompt: not loading .pi/SYSTEM.md: this pull request comes from a fork",
		);
		const inCheckout = await loadSystemPromptFiles(
			options({ cwd, workspace: cwd, agentDir: inside, fork: true, log }),
		);
		expect(inCheckout).toStrictEqual({ system: undefined, append: undefined });
		expect(log.info).toHaveBeenCalledWith(
			"System prompt: not loading agent_dir/SYSTEM.md: agent_dir is in the checkout of a pull request from a fork",
		);
	});

	it("reads nothing without the files or agent_dir", async () => {
		const log = createLogger();
		const files = await loadSystemPromptFiles(
			options({ cwd: tempDir(), trustProject: false, log }),
		);
		expect(files).toStrictEqual({ system: undefined, append: undefined });
		expect(log.info).not.toHaveBeenCalled();
	});

	it("removes invisible characters, and cuts a file at the limit with a warning", async () => {
		const cwd = tempDir();
		write(join(cwd, ".pi", "SYSTEM.md"), "\uFEFFYou are\u200B a bot é.");
		const log = createLogger();
		const files = await loadSystemPromptFiles(
			options({ cwd, maxBytes: 15, log }),
		);
		expect(files.system?.content).toBe("You are a bot ");
		expect(log.warning).toHaveBeenCalledWith(
			"System prompt: .pi/SYSTEM.md (16 B) was cut at context_files_max_bytes (15 bytes)",
		);
	});
});
