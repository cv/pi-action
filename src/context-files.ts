// The repository's context files (AGENTS.md, else CLAUDE.md) in the system prompt, as pi's coding agent loads them.
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
	defineExtension,
	type Extension,
	section,
} from "@earendil-works/pi-durable";

import { removeInvisibleCharacters } from "./security.ts";
import { git } from "./storage/git.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

/** The built-in pi-durable extension with the `project_context` section; installed right after the coding tools. */
export const CONTEXT_EXTENSION = "pi-action-context";
export const PROJECT_CONTEXT_SECTION = "project_context";
/** In each directory, the first of these that exists is loaded. */
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
/** At most this many nested files are listed by name. */
const MAX_LISTED = 20;
const NUL = "\0";

/** A context file as the model gets it. */
export interface ContextFile {
	/** The absolute path, as the section shows it. */
	path: string;
	/** For the log: relative to the workspace, or `agent_dir/AGENTS.md`. */
	label: string;
	content: string;
	/** The size of the file, after removing invisible characters. */
	bytes: number;
	/** Whether `content` was cut at the size limit. */
	cut: boolean;
}

/** What `loadProjectContext` found: the section text (undefined: no section) and what went into it. */
export interface ProjectContext {
	text: string | undefined;
	files: ContextFile[];
	/** Files left out at the size limit, by label. */
	skipped: string[];
	/** Context files below `cwd`, relative to it, that the model can read when it works there. */
	nested: string[];
	/** Set when a fork pull request's files come from the base commit. */
	base: string | undefined;
}

export interface ContextFilesOptions {
	/** The agent's working directory. */
	cwd: string;
	/** `GITHUB_WORKSPACE`: the files above it are never read. When unset or not above `cwd`, `cwd` is the root. */
	workspace: string | undefined;
	/** The `agent_dir` input, resolved; the global context file is read only when it is set. */
	agentDir: string | undefined;
	/** `context_files_max_bytes`: the limit of all files together. */
	maxBytes: number;
	/** A fork pull request: read the workspace's files from its base commit instead of the checkout. */
	base?: { sha: string; remote: string } | undefined;
	log: Log;
}

/** Where the workspace's files come from: the checkout, or a commit. */
interface Source {
	/** A file's content; undefined when it doesn't exist. `rel` is relative to the root, with `/`. */
	read: (rel: string) => Promise<string | undefined>;
	/** The paths of the files named like a context file in `dir` (relative to the root) and below, relative to `dir`. */
	list: (dir: string) => Promise<string[]>;
}

/** Whether `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const toPosix = (path: string): string => path.split(sep).join("/");

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

const splitNul = (out: string): string[] => out.split(NUL).filter(Boolean);

/** The files in the checkout, and the context files git knows below a directory (tracked, or untracked and not ignored). */
function checkoutSource(root: string): Source {
	return {
		read: async (rel) => readOptional(join(root, rel)),
		list: async (dir) => {
			const out = await git(join(root, dir), [
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
				"--",
				...CONTEXT_FILE_NAMES.map((name) => `:(glob)**/${name}`),
			]).catch(() => "");
			return splitNul(out);
		},
	};
}

/** The files at `sha`, fetched from `remote` when the clone doesn't have it; undefined when it can't be read. */
async function commitSource(
	root: string,
	sha: string,
	remote: string,
	log: Log,
): Promise<Source | undefined> {
	const has = async () =>
		git(root, ["cat-file", "-e", `${sha}^{commit}`]).then(
			() => true,
			() => false,
		);
	if (!(await has())) {
		const shallow = await git(root, ["rev-parse", "--is-shallow-repository"])
			.then((out) => out.trim() === "true")
			.catch(() => false);
		try {
			await git(root, [
				"fetch",
				"--no-tags",
				...(shallow ? ["--depth=1"] : []),
				remote,
				sha,
			]);
		} catch (error) {
			log.warning(
				`Context files: could not fetch the base commit ${sha.slice(0, 7)} of the pull request: ${getErrorMessage(error)}`,
			);
			return undefined;
		}
	}
	return {
		read: async (rel) =>
			git(root, ["show", `${sha}:./${rel}`]).catch(() => undefined),
		list: async (dir) => {
			const out = await git(join(root, dir), [
				"ls-tree",
				"-r",
				"-z",
				"--name-only",
				sha,
			]).catch(() => "");
			return splitNul(out).filter((path) =>
				(CONTEXT_FILE_NAMES as readonly string[]).includes(basename(path)),
			);
		},
	};
}

/** The first context file of `dir` (relative to the root) that `source` has. */
async function firstContextFile(
	source: Source,
	dir: string,
): Promise<{ rel: string; content: string } | undefined> {
	for (const name of CONTEXT_FILE_NAMES) {
		const rel = dir === "" ? name : `${dir}/${name}`;
		// oxlint-disable-next-line eslint/no-await-in-loop -- AGENTS.md wins over CLAUDE.md
		const content = await source.read(rel);
		if (content !== undefined) {
			return { rel, content };
		}
	}
	return undefined;
}

/** The directories from the root down to `cwd`, relative to the root (`""` is the root). */
function directoriesDown(root: string, cwd: string): string[] {
	const parts = toPosix(relative(root, cwd)).split("/").filter(Boolean);
	return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/** Of the nested files, one per directory (AGENTS.md before CLAUDE.md), without those of `cwd` itself; sorted. */
function nestedFiles(paths: readonly string[]): string[] {
	const byDir = new Map<string, string>();
	for (const path of paths) {
		const dir = dirname(path);
		const name = basename(path);
		const current = byDir.get(dir);
		if (
			dir !== "." &&
			(CONTEXT_FILE_NAMES as readonly string[]).includes(name) &&
			(current === undefined || name === CONTEXT_FILE_NAMES[0])
		) {
			byDir.set(dir, path);
		}
	}
	return [...byDir.values()].toSorted((a, b) => a.localeCompare(b));
}

/** At most `max` bytes of `text`, cut before a UTF-8 sequence that wouldn't fit. */
function cutUtf8(text: string, max: number): string {
	const buffer = Buffer.from(text, "utf8");
	let end = Math.max(0, max);
	// oxlint-disable-next-line no-bitwise -- a continuation byte is 0b10xxxxxx
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
		end -= 1;
	}
	return buffer.subarray(0, end).toString("utf8");
}

/** A size for the log: `512 B`, `2.1 KiB`. */
export function formatBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** The `project_context` section text, as pi's `# Project Context` block. */
export function renderProjectContext(
	context: Omit<ProjectContext, "text">,
	maxBytes: number,
): string | undefined {
	const { files, skipped, nested, base } = context;
	if (files.length === 0 && nested.length === 0) {
		return undefined;
	}
	const parts = ["# Project Context", "Project-specific instructions and guidelines:"];
	if (base !== undefined) {
		parts.push(
			`This pull request comes from a fork, so the repository's files below are from its base commit ${base.slice(0, 7)}, not from the pull request.`,
		);
	}
	for (const file of files) {
		parts.push(`## ${file.path}`, file.content.trim());
		if (file.cut) {
			parts.push(
				`[pi-action: this file was cut at the context_files_max_bytes limit of ${maxBytes} bytes; read it for the rest.]`,
			);
		}
	}
	if (skipped.length > 0) {
		parts.push(
			`[pi-action: not loaded, at the context_files_max_bytes limit: ${skipped.join(", ")}. Read them with your tools.]`,
		);
	}
	if (nested.length > 0) {
		const listed = nested.slice(0, MAX_LISTED).join(", ");
		const more =
			nested.length > MAX_LISTED ? ` and ${nested.length - MAX_LISTED} more` : "";
		parts.push(
			`More context files: ${listed}${more}. Read the one for the directory you work in.`,
		);
	}
	return parts.join("\n\n");
}

/**
 * The context files of a run, read once: the global one in `agent_dir` (when set), then one per directory from the
 * workspace root down to `cwd`. Never above the workspace. Files past `maxBytes` are cut or left out (a warning).
 * Invisible characters, which can hide instructions, are removed; HTML comments stay (they are common in AGENTS.md).
 */
export async function loadProjectContext(
	options: ContextFilesOptions,
): Promise<ProjectContext> {
	const { cwd, agentDir, maxBytes, log } = options;
	const root =
		options.workspace !== undefined && isInside(options.workspace, cwd)
			? options.workspace
			: cwd;
	let source: Source | undefined = checkoutSource(root);
	let base: string | undefined;
	if (options.base !== undefined) {
		source = await commitSource(root, options.base.sha, options.base.remote, log);
		if (source === undefined) {
			log.warning(
				"Context files: not loading the repository's AGENTS.md or CLAUDE.md, because this pull request comes from a fork and its base commit is not available",
			);
		} else {
			base = options.base.sha;
			log.info(
				`Context files: this pull request comes from a fork, so they are read from its base commit ${base.slice(0, 7)}`,
			);
		}
	}
	const found: { path: string; label: string; content: string }[] = [];
	if (agentDir !== undefined) {
		const inWorkspace = source !== undefined && isInside(root, agentDir);
		const dir = toPosix(relative(root, agentDir));
		for (const name of CONTEXT_FILE_NAMES) {
			const content =
				// oxlint-disable-next-line eslint/no-await-in-loop -- AGENTS.md wins over CLAUDE.md
				inWorkspace && source !== undefined
					? await source.read(dir === "" ? name : `${dir}/${name}`)
					: await readOptional(join(agentDir, name));
			if (content !== undefined) {
				found.push({ path: join(agentDir, name), label: `agent_dir/${name}`, content });
				break;
			}
		}
	}
	let nested: string[] = [];
	if (source !== undefined) {
		const dirs = directoriesDown(root, cwd);
		for (const dir of dirs) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- in order, from the root down
			const file = await firstContextFile(source, dir);
			if (file !== undefined) {
				found.push({ path: join(root, file.rel), label: file.rel, content: file.content });
			}
		}
		nested = nestedFiles(await source.list(dirs.at(-1) ?? ""));
	}
	const files: ContextFile[] = [];
	const skipped: string[] = [];
	let left = maxBytes;
	for (const { path, label, content: raw } of found) {
		const content = removeInvisibleCharacters(raw);
		const bytes = Buffer.byteLength(content, "utf8");
		if (left <= 0) {
			skipped.push(label);
		} else if (bytes <= left) {
			files.push({ path, label, content, bytes, cut: false });
			left -= bytes;
		} else {
			files.push({ path, label, content: cutUtf8(content, left), bytes, cut: true });
			left = 0;
		}
	}
	for (const file of files.filter((f) => f.cut)) {
		log.warning(
			`Context files: ${file.label} (${formatBytes(file.bytes)}) was cut at context_files_max_bytes (${maxBytes} bytes in total)`,
		);
	}
	if (skipped.length > 0) {
		log.warning(
			`Context files: not loaded, at context_files_max_bytes (${maxBytes} bytes in total): ${skipped.join(", ")}`,
		);
	}
	log.info(
		`Context files: ${files.map((file) => `${file.label} (${formatBytes(file.bytes)}${file.cut ? ", cut" : ""})`).join(", ") || "none"}${nested.length > 0 ? `; listed: ${nested.length} nested` : ""}`,
	);
	const context = { files, skipped, nested, base };
	return { ...context, text: renderProjectContext(context, maxBytes) };
}

/**
 * The `pi-action-context` extension: the `project_context` section with `text`, read once for the run, so that the
 * agent's edits of AGENTS.md during the run don't change the prompt (and its cache). No section when `text` is
 * undefined.
 */
export function contextExtension(text: string | undefined): Extension {
	return defineExtension({
		name: CONTEXT_EXTENSION,
		sections: [section(PROJECT_CONTEXT_SECTION, () => text)],
	});
}
