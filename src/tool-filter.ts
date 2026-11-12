// The `exclude_tools` and `model_tools_hidden` inputs: which tools a thread's model is offered, and which exist at all.
import type { Log } from "./types.ts";

/** Tool name patterns from the inputs; `*` matches any run of characters. */
export interface ToolSelection {
	/** `exclude_tools`: these tools are disabled; neither the model nor other tools can call them. */
	exclude: readonly string[];
	/** `model_tools_hidden`: the model is not offered these tools; other tools (pit's `tools.*`) can still call them. */
	hidden: readonly string[];
}

/** What a selection resolves to against the thread's tools. */
export interface ToolPlan {
	/** The tools to disable. */
	exclude: string[];
	/** The tools to hide from the model. */
	hide: string[];
	/** The tools the model is offered, in order. */
	offered: string[];
}

const SPECIAL = /[.+?^${}()|[\]\\]/gu;

/** A matcher for one `*` glob: the whole name must match. */
function compilePattern(pattern: string): RegExp {
	const source = pattern.replaceAll(SPECIAL, String.raw`\$&`).replaceAll("*", ".*");
	return new RegExp(`^${source}$`, "u");
}

/** The names among `names` that `patterns` match, in order; writes a warning for each pattern that matches none. */
function matching(
	input: string,
	patterns: readonly string[],
	names: readonly string[],
	log: Log,
): string[] {
	const matched = new Set<string>();
	for (const pattern of patterns) {
		const regex = compilePattern(pattern);
		const hits = names.filter((name) => regex.test(name));
		if (hits.length === 0) {
			log.warning(`${input}: "${pattern}" matches no tool`);
		}
		for (const hit of hits) {
			matched.add(hit);
		}
	}
	return names.filter((name) => matched.has(name));
}

/**
 * Resolve the selection against the thread's tools: `all` (every enabled tool, after the wraps) and `offered` (the ones
 * the model gets without a selection). Throws if the selection leaves the model with no tools.
 */
export function planTools(
	selection: ToolSelection,
	all: readonly string[],
	offered: readonly string[],
	log: Log,
): ToolPlan {
	const exclude = matching("exclude_tools", selection.exclude, all, log);
	const hide = matching("model_tools_hidden", selection.hidden, all, log);
	const removed = new Set([...exclude, ...hide]);
	const kept = offered.filter((name) => !removed.has(name));
	if (kept.length === 0 && removed.size > 0) {
		throw new Error(
			`exclude_tools and model_tools_hidden leave the model with no tools (it would have ${offered.join(", ")})`,
		);
	}
	return { exclude, hide, offered: kept };
}
