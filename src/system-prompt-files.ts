// SYSTEM.md and APPEND_SYSTEM.md, as pi's coding agent finds them (`discoverSystemPromptFile` in pi's resource loader).
import { join } from "node:path";

import {
	cutUtf8,
	formatBytes,
	isInside,
	readOptional,
} from "./context-files.ts";
import { removeInvisibleCharacters } from "./security.ts";
import type { Log } from "./types.ts";

/** A system prompt file as the model gets it. */
interface SystemPromptFile {
	/** For the log: `.pi/SYSTEM.md` or `agent_dir/SYSTEM.md`. */
	label: string;
	content: string;
}

/** What `loadSystemPromptFiles` found: `SYSTEM.md` replaces pi's base sections, `APPEND_SYSTEM.md` is the `addendum`. */
export interface SystemPromptFiles {
	system?: SystemPromptFile | undefined;
	append?: SystemPromptFile | undefined;
}

export interface SystemPromptFilesOptions {
	/** The agent's working directory: the project's files are in `<cwd>/.pi`. */
	cwd: string;
	/** `GITHUB_WORKSPACE`, for whether `agentDir` is in the checkout; `cwd` when unset or not above it. */
	workspace: string | undefined;
	/** The `agent_dir` input, resolved; its files are read only when it is set. */
	agentDir: string | undefined;
	/** `trust_project`: the project's files are read only with it. */
	trustProject: boolean;
	/** A pull request from a fork: its author controls the checkout, so no file of the checkout is read. */
	fork: boolean;
	/** `context_files_max_bytes`: the limit of each file. */
	maxBytes: number;
	log: Log;
}

const FILES = [
	{ key: "system", name: "SYSTEM.md" },
	{ key: "append", name: "APPEND_SYSTEM.md" },
] as const;

/** One file, without invisible characters, cut at `maxBytes` (a warning); undefined when missing or blank. */
async function readFileAt(
	path: string,
	label: string,
	maxBytes: number,
	log: Log,
): Promise<SystemPromptFile | undefined> {
	const raw = await readOptional(path);
	const text = raw === undefined ? "" : removeInvisibleCharacters(raw).trim();
	if (text === "") {
		return undefined;
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > maxBytes) {
		log.warning(
			`System prompt: ${label} (${formatBytes(bytes)}) was cut at context_files_max_bytes (${maxBytes} bytes)`,
		);
		return { label, content: cutUtf8(text, maxBytes) };
	}
	return { label, content: text };
}

/** Why the project's file can't be used (undefined: it can), as pi-action logs it. */
function projectSkip(options: SystemPromptFilesOptions): string | undefined {
	if (!options.trustProject) {
		return "trust_project is off";
	}
	return options.fork ? "this pull request comes from a fork" : undefined;
}

/** The file named `name`: `<cwd>/.pi/<name>` with trust_project, else `<agent_dir>/<name>`, as in pi. */
async function findFile(
	options: SystemPromptFilesOptions,
	root: string,
	name: string,
): Promise<SystemPromptFile | undefined> {
	const { cwd, agentDir, fork, maxBytes, log } = options;
	const label = `.pi/${name}`;
	const skip = projectSkip(options);
	if (skip === undefined) {
		const project = await readFileAt(
			join(cwd, ".pi", name),
			label,
			maxBytes,
			log,
		);
		if (project !== undefined) {
			return project;
		}
	} else if ((await readOptional(join(cwd, ".pi", name))) !== undefined) {
		log.info(`System prompt: not loading ${label}: ${skip}`);
	}
	if (agentDir === undefined) {
		return undefined;
	}
	const userLabel = `agent_dir/${name}`;
	const path = join(agentDir, name);
	if (fork && isInside(root, agentDir)) {
		if ((await readOptional(path)) !== undefined) {
			log.info(
				`System prompt: not loading ${userLabel}: agent_dir is in the checkout of a pull request from a fork`,
			);
		}
		return undefined;
	}
	return readFileAt(path, userLabel, maxBytes, log);
}

/**
 * The run's `SYSTEM.md` and `APPEND_SYSTEM.md`, read once. Each is `<cwd>/.pi/<name>` when the project is trusted
 * and the run is not on a pull request from a fork, else `<agent_dir>/<name>` when `agent_dir` is set. Invisible
 * characters (BOMs too) are removed; a blank file counts as missing, as in pi.
 */
export async function loadSystemPromptFiles(
	options: SystemPromptFilesOptions,
): Promise<SystemPromptFiles> {
	const { cwd, log } = options;
	const root =
		options.workspace !== undefined && isInside(options.workspace, cwd)
			? options.workspace
			: cwd;
	const [system, append] = await Promise.all(
		FILES.map(async ({ name }) => findFile(options, root, name)),
	);
	if (system !== undefined) {
		log.info(
			`System prompt: ${system.label} (${formatBytes(Buffer.byteLength(system.content, "utf8"))}, replaces pi's base prompt)`,
		);
	}
	if (append !== undefined) {
		log.info(
			`System prompt: appended ${append.label} (${formatBytes(Buffer.byteLength(append.content, "utf8"))})`,
		);
	}
	return { system, append };
}
