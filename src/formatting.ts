// The comments pi-action posts, and existing PR review comments as prompt context.
import type { GitHubComment } from "./types.ts";

/** `ref`, the thread's ref (e.g. refs/pi/threads/42), adds a footer saying where the thread is stored. */
function footer(ref: string | undefined): string {
	return ref
		? `\n\n---\n🧵 Thread state: \`${ref}\` (\`git fetch origin ${ref}\`)`
		: "";
}

export function formatSuccessComment(response: string, ref?: string): string {
	return `### 🤖 pi Response\n\n${response}${footer(ref)}`;
}

export function formatErrorComment(error: string, ref?: string): string {
	return `### ❌ pi Error\n\nFailed to process request: ${error}${footer(ref)}`;
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
