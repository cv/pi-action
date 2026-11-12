import type { Trigger } from "./triggers.ts";

export function hasTrigger(text: string, trigger: string): boolean {
	return text.toLowerCase().includes(trigger.toLowerCase());
}

/** Appended to every first prompt: the runner, and anything left uncommitted on it, is gone after the run. */
const RUNNER_REQUIREMENTS = `## Important: Artifact and Script Requirements

**CRITICAL:** After the GitHub Action finishes running, all files modified or created are lost, and the GitHub Action runner is destroyed. Therefore:

1. **All generated code and artifacts MUST be committed** - Any files you create, modify, or generate must be committed and pushed to the repository before the action completes. Nothing will persist otherwise.

2. **Any throw-away scripts generated MUST be run immediately** - If you create temporary scripts (like \`/tmp/create-issues.sh\` or similar), you must execute them during the same session. They will be lost when the runner terminates.

3. **Commit and push all work** - Always end your work by committing and pushing changes to ensure they persist beyond the GitHub Action execution.
`;

/**
 * In comment mode, pi-action posts the final response of each request as a comment. pi's tools have a token that
 * can comment too, and without this it may post its reply with `gh` as well: two comments for one answer (#42).
 */
const REPLY_SECTION = `## Your Reply

pi-action posts your final response as a comment on this issue or pull request. **Do not post your reply yourself**, for example with \`gh issue comment\`, \`gh pr comment\`, \`gh pr review\`, or \`gh api\`. That would post the same answer twice. Use \`gh\` to comment only where the task asks for it, such as on another issue.
`;

/** Appended to each later message (a follow-up or an answer) in comment mode, for threads of any age. */
export const REPLY_REMINDER =
	"_(pi-action posts your final response as a comment here. Don't also post it with `gh`.)_";

/** A later message on the thread, with the reminder that pi-action posts the reply. */
export function withReplyReminder(message: string): string {
	return `${message}\n\n${REPLY_REMINDER}`;
}

export function extractTask(comment: string, trigger: string): string {
	const idx = comment.toLowerCase().indexOf(trigger.toLowerCase());
	if (idx === -1) {
		return comment;
	}
	return comment.slice(idx + trigger.length).trim();
}

interface BasePIContext {
	type: "issue" | "pull_request" | "direct";
	title: string;
	task: string;
}

interface IssuePIContext extends BasePIContext {
	type: "issue";
	body: string;
	number: number;
	triggerComment: string;
}

interface PullRequestPIContext extends BasePIContext {
	type: "pull_request";
	body: string;
	number: number;
	triggerComment: string;
	diff?: string;
	reviewComments?: string;
}

interface DirectPIContext extends BasePIContext {
	type: "direct";
}

export type PIContext = IssuePIContext | PullRequestPIContext | DirectPIContext;

const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/gu;

const TYPE_DISPLAY: Record<PIContext["type"], string> = {
	issue: "Issue",
	pull_request: "Pull Request",
	direct: "Direct Task",
};

export function renderTemplate(template: string, context: PIContext): string {
	const isDirect = context.type === "direct";
	const variables = new Map(
		Object.entries({
			type: context.type,
			type_display: TYPE_DISPLAY[context.type],
			number: isDirect ? "0" : context.number.toString(),
			title: context.title,
			body: isDirect ? "" : context.body,
			task: context.task,
			diff: context.type === "pull_request" ? (context.diff ?? "") : "",
			reviewComments:
				context.type === "pull_request" ? (context.reviewComments ?? "") : "",
			trigger_comment: isDirect ? context.task : context.triggerComment,
		}),
	);
	// One pass with a replacer: values go in literally ("$&" stays "$&"), and a placeholder inside a value (an
	// issue body that says {{diff}}) stays text instead of being expanded.
	return template.replaceAll(
		PLACEHOLDER_PATTERN,
		(placeholder, key: string) => variables.get(key) ?? placeholder,
	);
}

export interface PromptOptions {
	/** pi-action posts the final response as a comment (comment mode, on an issue or PR). */
	repliesAsComment?: boolean;
}

export function buildPrompt(
	context: PIContext,
	customTemplate?: string,
	options: PromptOptions = {},
): string {
	if (customTemplate?.trim()) {
		return renderTemplate(customTemplate, context);
	}

	if (context.type === "direct") {
		return `# Direct pi Task

## Task
${context.task}

${RUNNER_REQUIREMENTS}`;
	}

	let prompt = `# GitHub ${TYPE_DISPLAY[context.type]} #${context.number}

## Title
${context.title}

## Description
${context.body}

${context.type === "pull_request" ? (context.reviewComments ?? "") : ""}
## Task
${context.task}

${options.repliesAsComment === true ? `${REPLY_SECTION}\n` : ""}${RUNNER_REQUIREMENTS}`;

	if (context.type === "pull_request" && context.diff) {
		prompt += `\n## PR Diff\n\`\`\`diff\n${context.diff}\n\`\`\`\n`;
	}

	return prompt;
}

/** A later comment on an existing thread: the conversation already has the issue's context. */
export function formatFollowUp(
	trigger: Pick<Trigger, "author" | "source" | "task" | "url">,
): string {
	const verb =
		trigger.source === "review_comment" ? "commented on the diff" : "commented";
	const where = trigger.url ? ` (${trigger.url})` : "";
	return `**@${trigger.author.login}** ${verb}${where}:\n\n${trigger.task}`;
}
