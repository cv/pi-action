#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ISSUE_NUMBER_PATTERN = /\d+/u;

export function issueNumberFromBranch(branchName) {
	return branchName.match(ISSUE_NUMBER_PATTERN)?.[0];
}

export async function appendIssueReference(
	messageFile,
	branchName,
	commitSource = "",
) {
	if (commitSource) {
		return false;
	}

	let branch = branchName;
	if (branch === undefined) {
		try {
			branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return false;
		}
	}
	const issueNumber = issueNumberFromBranch(branch);
	if (!issueNumber) {
		return false;
	}

	const message = await readFile(messageFile, "utf8");
	if (message.includes(`#${issueNumber}`)) {
		return false;
	}

	await appendFile(messageFile, `\nRefs #${issueNumber}\n`);
	return true;
}

async function main() {
	const [messageFile, commitSource = ""] = process.argv.slice(2);
	if (!messageFile) {
		throw new Error("commit message file is required");
	}
	await appendIssueReference(messageFile, undefined, commitSource);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
