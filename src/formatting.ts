/**
 * Response formatting utilities for consistent GitHub comment formatting
 */

import type { PullRequestReviewComment } from "./types.ts";

export interface CommentFooter {
	/** The thread's ref, e.g. refs/pi/threads/42. */
	ref?: string | undefined;
}

function footer(info: CommentFooter | undefined): string {
	return info?.ref
		? `\n\n---\n🧵 Thread state: \`${info.ref}\` (\`git fetch origin ${info.ref}\`)`
		: "";
}

export function formatSuccessComment(
	response: string,
	info?: CommentFooter,
): string {
	return `### 🤖 pi Response\n\n${response}${footer(info)}`;
}

export function formatErrorComment(
	error: string,
	info?: CommentFooter,
): string {
	return `### ❌ pi Error\n\nFailed to process request: ${error}${footer(info)}`;
}

export function formatReviewComments(
	comments: PullRequestReviewComment[],
): string {
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
		const author = comment.user.login;
		const [date = ""] = new Date(comment.created_at).toISOString().split("T");
		const location =
			comment.path && comment.line ? ` (${comment.path}:${comment.line})` : "";

		sections.push(`**${author}** on ${date}${location}:`);
		sections.push(comment.body);
		sections.push("");
	}

	return sections.join("\n");
}
