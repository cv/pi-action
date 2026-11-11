import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import type { DurableExtensionFactory } from "./extensions.ts";
import type { DurableUi, Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

export interface DurableExtensionsOptions {
	/** The workspace (the checked-out repository). */
	cwd: string;
	/** The `agent_dir` input, relative to the workspace; a temp dir under RUNNER_TEMP when unset. */
	agentDir: string | undefined;
	/** The `trust_project` input. */
	trustProject: boolean;
	/** The GitHub UI, in comment mode on an issue or PR. */
	ui: DurableUi | undefined;
	log: Log;
	env: Record<string, string | undefined>;
}

/** The `agent_dir` input, or a fresh directory under RUNNER_TEMP. */
async function agentDirectory(
	options: DurableExtensionsOptions,
): Promise<string> {
	if (options.agentDir) {
		const dir = resolve(options.cwd, options.agentDir);
		await mkdir(dir, { recursive: true });
		return dir;
	}
	const base = options.env["RUNNER_TEMP"] || tmpdir();
	await mkdir(base, { recursive: true });
	return mkdtemp(join(base, "pi-action-agent-"));
}

/**
 * Builds the pi-durable extensions the `extensions` input declared, with the run's host options, for the thread's
 * registry. Their names must not collide with each other or with pi-action's coding tools.
 */
export async function createDurableExtensions(
	factories: readonly DurableExtensionFactory[],
	options: DurableExtensionsOptions,
): Promise<Extension[]> {
	if (factories.length === 0) {
		return [];
	}
	const { cwd, trustProject, ui, log } = options;
	const agentDir = await agentDirectory(options);
	log.info(
		`pi-durable extensions: agent directory ${agentDir}, project ${trustProject ? "trusted" : "not trusted"}, ${ui ? "questions answered on GitHub" : "no UI"}`,
	);
	const names = new Set([CodingTools.name]);
	const extensions: Extension[] = [];
	for (const factory of factories) {
		let extension: Extension;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop -- extensions are created in order, as they were loaded
			extension = await factory.create({
				cwd,
				agentDir,
				trustProject,
				...(ui ? { ui } : {}),
				log: { info: log.info, warning: log.warning },
			});
		} catch (error) {
			throw new Error(
				`Could not create pi-durable extension ${factory.source}: ${getErrorMessage(error)}`,
				{ cause: error },
			);
		}
		if (names.has(extension.name)) {
			throw new Error(
				`pi-durable extension ${factory.source} is named "${extension.name}", which is already taken`,
			);
		}
		names.add(extension.name);
		log.info(
			`pi-durable extension ${extension.name} (${factory.source}): ${(extension.tools ?? []).map((tool) => tool.name).join(", ") || "no tools"}`,
		);
		extensions.push(extension);
	}
	return extensions;
}
