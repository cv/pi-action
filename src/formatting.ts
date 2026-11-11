/**
 * Response formatting utilities for consistent GitHub comment formatting
 */

export interface CommentFooter {
	/** The thread's ref, e.g. refs/pi/threads/42. */
	ref?: string;
	/** Who the response answers, e.g. ["alice", "bob"]. */
	replyTo?: string[];
}

function footer(info: CommentFooter | undefined): string {
	const parts: string[] = [];
	if (info?.replyTo && info.replyTo.length > 1) {
		parts.push(
			`↩️ Answers ${info.replyTo.map((login) => `@${login}`).join(", ")}`,
		);
	}
	if (info?.ref) {
		parts.push(
			`🧵 Thread state: \`${info.ref}\` (\`git fetch origin ${info.ref}\`)`,
		);
	}
	return parts.length > 0 ? `\n\n---\n<sub>${parts.join(" · ")}</sub>` : "";
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
