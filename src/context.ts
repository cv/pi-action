export function hasTrigger(text: string, trigger: string): boolean {
	return text.toLowerCase().includes(trigger.toLowerCase());
}

export function extractTask(comment: string, trigger: string): string {
	const idx = comment.toLowerCase().indexOf(trigger.toLowerCase());
	if (idx === -1) {
		return comment;
	}
	return comment.slice(idx + trigger.length).trim();
}

export interface PIContext {
	type: "issue" | "pull_request" | "direct";
	title: string;
	body: string;
	number: number;
	triggerComment: string;
	task: string;
	diff?: string;
	reviewComments?: string;
}

function getTypeDisplay(type: PIContext["type"]): string {
	if (type === "pull_request") {
		return "Pull Request";
	}
	if (type === "direct") {
		return "Direct Task";
	}
	return "Issue";
}

export function renderTemplate(template: string, context: PIContext): string {
	// Template variables that can be used in the custom template
	const variables = {
		type: context.type,
		type_display: getTypeDisplay(context.type),
		number: context.number.toString(),
		title: context.title,
		body: context.body,
		task: context.task,
		diff: context.diff || "",
		reviewComments: context.reviewComments || "",
		trigger_comment: context.triggerComment,
	};

	// Replace all template variables
	let rendered = template;
	for (const [key, value] of Object.entries(variables)) {
		const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, "g");
		rendered = rendered.replace(placeholder, value);
	}

	return rendered;
}

export function buildPrompt(
	context: PIContext,
	customTemplate?: string,
): string {
	// If custom template is provided and not empty, use it
	if (customTemplate?.trim()) {
		return renderTemplate(customTemplate, context);
	}

	if (context.type === "direct") {
		return `# Direct pi Task

## Task
${context.task}

## Important: Artifact and Script Requirements

**CRITICAL:** After the GitHub Action finishes running, all files modified or created are lost, and the GitHub Action runner is destroyed. Therefore:

1. **All generated code and artifacts MUST be committed** - Any files you create, modify, or generate must be committed and pushed to the repository before the action completes. Nothing will persist otherwise.

2. **Any throw-away scripts generated MUST be run immediately** - If you create temporary scripts (like \`/tmp/create-issues.sh\` or similar), you must execute them during the same session. They will be lost when the runner terminates.

3. **Commit and push all work** - Always end your work by committing and pushing changes to ensure they persist beyond the GitHub Action execution.
`;
	}

	// Default template (preserving backward compatibility)
	let prompt = `# GitHub ${getTypeDisplay(context.type)} #${context.number}

## Title
${context.title}

## Description
${context.body}

${context.reviewComments || ""}
## Task
${context.task}

## Important: Artifact and Script Requirements

**CRITICAL:** After the GitHub Action finishes running, all files modified or created are lost, and the GitHub Action runner is destroyed. Therefore:

1. **All generated code and artifacts MUST be committed** - Any files you create, modify, or generate must be committed and pushed to the repository before the action completes. Nothing will persist otherwise.

2. **Any throw-away scripts generated MUST be run immediately** - If you create temporary scripts (like \`/tmp/create-issues.sh\` or similar), you must execute them during the same session. They will be lost when the runner terminates.

3. **Commit and push all work** - Always end your work by committing and pushing changes to ensure they persist beyond the GitHub Action execution.
`;

	if (context.diff) {
		prompt += `\n## PR Diff\n\`\`\`diff\n${context.diff}\n\`\`\`\n`;
	}

	return prompt;
}
