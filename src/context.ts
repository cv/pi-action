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

const TYPE_DISPLAY: Record<PIContext["type"], string> = {
	issue: "Issue",
	pull_request: "Pull Request",
	direct: "Direct Task",
};

export function renderTemplate(template: string, context: PIContext): string {
	const isDirect = context.type === "direct";
	const variables = {
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
	};

	let rendered = template;
	for (const [key, value] of Object.entries(variables)) {
		const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, "gu");
		rendered = rendered.replaceAll(placeholder, value);
	}

	return rendered;
}

export function buildPrompt(
	context: PIContext,
	customTemplate?: string,
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

${RUNNER_REQUIREMENTS}`;

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
