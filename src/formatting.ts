// The comments pi-action posts, and existing PR review comments as prompt context.
import type { GitHubComment } from "./types.ts";

const READ_A_THREAD =
	"https://github.com/cv/pi-action/blob/main/docs/threads.md#read-a-thread";

/** The commands of docs/threads.md#read-a-thread for `ref` on `remote`. */
function readCommands(ref: string, remote: string): string[] {
	return [
		`git fetch ${remote} '${ref}:${ref}'`,
		`git log --oneline ${ref}            # one commit for each stored step`,
		`git show ${ref}:batch.json | jq .   # the records of the newest step`,
	];
}

/**
 * `ref`, the thread's ref (e.g. refs/pi/threads/42), adds a footer: where the conversation is stored, collapsed, with
 * the git commands that read it from a clone (#80).
 */
function footer(ref: string | undefined): string {
	if (!ref) {
		return "";
	}
	return [
		"",
		"",
		`<details><summary><sub>🧵 This conversation is stored in git on <code>${ref}</code></sub></summary>`,
		"",
		`Read it from a clone of this repository ([more](${READ_A_THREAD})):`,
		"",
		"```bash",
		...readCommands(ref, "origin"),
		"```",
		"",
		"</details>",
	].join("\n");
}

export function formatSuccessComment(response: string, ref?: string): string {
	return `### 🤖 pi Response\n\n${response}${footer(ref)}`;
}

export function formatErrorComment(error: string, ref?: string): string {
	return `### ❌ pi Error\n\nFailed to process request: ${error}${footer(ref)}`;
}

/** How to read the thread with git, for the workflow log. */
export function formatThreadLog(ref: string, remote: string): string {
	return [
		`This conversation is stored in git on ${ref}. To read it:`,
		...readCommands(ref, remote).map((command) => `  ${command}`),
		`See ${READ_A_THREAD}`,
	].join("\n");
}

export function formatReviewComments(comments: GitHubComment[]): string {
	if (comments.length === 0) {
		return "";
	}
	const sections: string[] = [
		"## Existing PR Review Comments",
		"",
		"These comments were already present on the PR. Do not re-fetch them unless you need newer comments.",
		"",
	];
	for (const comment of comments) {
		const author = comment.user?.login ?? "ghost";
		const [date = ""] = new Date(comment.created_at).toISOString().split("T");
		const location =
			comment.path && typeof comment.line === "number"
				? ` (${comment.path}:${comment.line})`
				: "";
		sections.push(
			`**${author}** on ${date}${location}:`,
			comment.body ?? "",
			"",
		);
	}
	return sections.join("\n");
}
