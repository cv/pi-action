// Vendored test helper.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempRepo(): { dir: string; git: (...args: string[]) => string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "git-pi-durable-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
