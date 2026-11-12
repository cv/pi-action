// pi-action's own pi-durable extension: what pi's coding agent puts in its system prompt, for every conversation.
import { defineExtension, type Extension } from "@earendil-works/pi-durable";

import { type Skills, skillsSection } from "./skills.ts";

/** The built-in extension's name, which pi-durable extensions from the `extensions` input can't take. */
export const BUILTIN_EXTENSION = "pi-action";

export interface BuiltinExtensionOptions {
	/** The run's skills, listed in the `available_skills` section. */
	skills: Skills;
}

/**
 * The built-in extension: the `available_skills` section. It is installed after the coding tools and before the
 * extensions of the `extensions` input, so their wraps (`wrapSection("available_skills", ...)`) apply to it.
 */
export function createBuiltinExtension(
	options: BuiltinExtensionOptions,
): Extension {
	return defineExtension({
		name: BUILTIN_EXTENSION,
		sections: [skillsSection(options.skills)],
	});
}
