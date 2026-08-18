#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMIT_MSG_HOOK = `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const messageFile = process.argv[2];
const message = messageFile ? readFileSync(messageFile, "utf8") : "";
const conventionalCommit = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\(.+\\))?: .+/u;

if (!conventionalCommit.test(message)) {
  console.error("\\n❌ Commit message does not follow Conventional Commits format!\\n\\nExpected format: type(scope?): description\\n\\nTypes: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert\\n\\nExamples:\\n  feat: add new feature\\n  fix(auth): resolve login issue\\n  docs: update README\\n\\nYour message: " + message);
  process.exitCode = 1;
}
`;

export const PREPARE_COMMIT_MSG_HOOK = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [messageFile, commitSource = ""] = process.argv.slice(2);
if (messageFile && !commitSource) {
  let branchName = "";
  try {
    branchName = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}

  const issueNumber = branchName.match(/\\d+/u)?.[0];
  const message = readFileSync(messageFile, "utf8");
  if (issueNumber && !message.includes("#" + issueNumber)) {
    appendFileSync(messageFile, "\\nRefs #" + issueNumber + "\\n");
  }
}
`;

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export function resolveHooksDirectory(cwd = process.cwd()) {
	return execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

export async function installAgentHooks(cwd = process.cwd()) {
	let hooksDirectory;
	try {
		hooksDirectory = resolveHooksDirectory(cwd);
	} catch {
		process.stdout.write(
			"⚠️ Not a git repository, skipping hooks installation\n",
		);
		return [];
	}

	const absoluteHooksDirectory = resolve(cwd, hooksDirectory);
	await mkdir(absoluteHooksDirectory, { recursive: true });
	process.stdout.write("🪝 Installing pi-agent git hooks...\n");

	const hooks = [
		["commit-msg", COMMIT_MSG_HOOK, "conventional commits"],
		["prepare-commit-msg", PREPARE_COMMIT_MSG_HOOK, "auto issue linking"],
	];
	const installed = (
		await Promise.all(
			hooks.map(async ([name, hookContent, description]) => {
				const path = join(absoluteHooksDirectory, name);
				if (await exists(path)) {
					process.stdout.write(`  ⏭️ ${name} hook already exists, skipping\n`);
					return;
				}
				await writeFile(path, hookContent, { mode: 0o755 });
				await chmod(path, 0o755);
				process.stdout.write(`  ✓ ${name} hook installed (${description})\n`);
				return path;
			}),
		)
	).filter((path) => path !== undefined);

	process.stdout.write("✅ Git hooks ready!\n");
	return installed;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	installAgentHooks().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
