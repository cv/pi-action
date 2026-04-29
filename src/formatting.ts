/**
 * Response formatting utilities for consistent GitHub comment formatting
 */

import type { PullRequestReviewComment } from "./types.js";

export function formatSuccessComment(
	response: string,
	shareUrl?: string,
): string {
	let comment = `### 🤖 pi Response\n\n${response}`;

	if (shareUrl) {
		comment += `\n\n---\n📎 [View full session](${shareUrl})`;
	}

	return comment;
}

export function formatErrorComment(error: string, shareUrl?: string): string {
	let comment = `### ❌ pi Error\n\nFailed to process request: ${error}`;

	if (shareUrl) {
		comment += `\n\n---\n📎 [View full session](${shareUrl})`;
	}

	return comment;
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
		const date = new Date(comment.created_at).toISOString().split("T")[0];
		const location =
			comment.path && comment.line ? ` (${comment.path}:${comment.line})` : "";

		sections.push(`**${author}** on ${date}${location}:`);
		sections.push(comment.body);
		sections.push("");
	}

	return sections.join("\n");
}
