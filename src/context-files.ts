// The repository's context files (AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD) in the system prompt, as pi's coding agent loads them.
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { removeInvisibleCharacters } from "./security.ts";
import { git } from "./storage/git.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

/** The key of the section with the context files, in the built-in `pi-action` extension (builtin-extension.ts). */
export const PROJECT_CONTEXT_SECTION = "project_context";
/**
 * In each directory, the first of these that is a file is loaded: pi's `loadContextFileFromDir`, in its order. Git
 * matches names case-sensitively (a fork's base commit), so `AGENTS.MD` and `CLAUDE.MD` are entries of their own.
 */
const CONTEXT_FILE_NAMES: readonly string[] = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];
/** At most this many nested files are listed by name. */
const MAX_LISTED = 20;
const NUL = "\0";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** A context file as the model gets it. */
interface ContextFile {
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
export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const toPosix = (path: string): string => path.split(sep).join("/");

export async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Whether `path` is a file (following symlinks), as pi's `isFile()` check. */
async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

const splitNul = (out: string): string[] => out.split(NUL).filter(Boolean);

/** The files in the checkout, and the context files git knows below a directory (tracked, or untracked and not ignored). */
function checkoutSource(root: string): Source {
	return {
		// A directory named like a context file is skipped: readFile fails on it.
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
			const paths = splitNul(out).filter((path) =>
				CONTEXT_FILE_NAMES.includes(basename(path)),
			);
			const files = await Promise.all(
				paths.map(async (path) => isFile(join(root, dir, path))),
			);
			return paths.filter((_, index) => files[index] === true);
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
	if (!OBJECT_ID.test(sha)) {
		log.warning(
			"Context files: the event names no base commit of the pull request",
		);
		return undefined;
	}
	const has = async () =>
		git(root, ["cat-file", "-e", `${sha}^{commit}`])
			.then(() => true)
			.catch(() => false);
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
			// cat-file blob fails on a tree: a directory named like a context file is skipped.
			git(root, ["cat-file", "blob", `${sha}:./${rel}`]).catch(() => undefined),
		list: async (dir) => {
			const out = await git(join(root, dir), [
				"ls-tree",
				"-r",
				"-z",
				sha,
			]).catch(() => "");
			// `<mode> <type> <object>\t<path>`: only blobs, not submodules.
			return splitNul(out).flatMap((entry) => {
				const tab = entry.indexOf("\t");
				const path = entry.slice(tab + 1);
				return entry.split(" ")[1] === "blob" &&
					CONTEXT_FILE_NAMES.includes(basename(path))
					? [path]
					: [];
			});
		},
	};
}

/** The first context file of `dir` (relative to the root) that `read` finds, in the order of `CONTEXT_FILE_NAMES`. */
async function firstContextFile(
	read: Source["read"],
	dir: string,
): Promise<{ rel: string; content: string } | undefined> {
	const rels = CONTEXT_FILE_NAMES.map((name) =>
		dir === "" ? name : `${dir}/${name}`,
	);
	const contents = await Promise.all(rels.map(async (rel) => read(rel)));
	const index = contents.findIndex((content) => content !== undefined);
	const rel = rels[index];
	const content = contents[index];
	return rel === undefined || content === undefined
		? undefined
		: { rel, content };
}

/** The directories from the root down to `cwd`, relative to the root (`""` is the root). */
function directoriesDown(root: string, cwd: string): string[] {
	const parts = toPosix(relative(root, cwd)).split("/").filter(Boolean);
	return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/** Of the nested files, one per directory (the first in `CONTEXT_FILE_NAMES`), without those of `cwd` itself; sorted. */
function nestedFiles(paths: readonly string[]): string[] {
	const byDir = new Map<string, string>();
	for (const path of paths) {
		const dir = dirname(path);
		const name = basename(path);
		const current = byDir.get(dir);
		if (
			dir !== "." &&
			CONTEXT_FILE_NAMES.includes(name) &&
			(current === undefined ||
				CONTEXT_FILE_NAMES.indexOf(name) <
					CONTEXT_FILE_NAMES.indexOf(basename(current)))
		) {
			byDir.set(dir, path);
		}
	}
	return [...byDir.values()].toSorted((a, b) => a.localeCompare(b));
}

/** At most `max` bytes of `text`, cut between characters. */
export function cutUtf8(text: string, max: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		bytes += Buffer.byteLength(char, "utf8");
		if (bytes > max) {
			break;
		}
		end += char.length;
	}
	return text.slice(0, end);
}

/** A size for the log: `512 B`, `2.1 KiB`. */
export function formatBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * The `project_context` section text, as pi renders it: a `<project_instructions>` block for each file. pi-action's
 * notes (nested files, the size limit, a fork's base commit) come after the files.
 */
function renderProjectContext(
	context: Omit<ProjectContext, "text">,
	maxBytes: number,
): string | undefined {
	const { files, skipped, nested, base } = context;
	if (files.length === 0 && nested.length === 0) {
		return undefined;
	}
	const parts = [
		"Project-specific instructions and guidelines:",
		...files.map(
			(file) =>
				`<project_instructions path="${file.path}">\n${file.content.trim()}\n</project_instructions>`,
		),
	];
	if (nested.length > 0) {
		const listed = nested.slice(0, MAX_LISTED).join(", ");
		const more =
			nested.length > MAX_LISTED
				? ` and ${nested.length - MAX_LISTED} more`
				: "";
		parts.push(
			`More context files: ${listed}${more}. Read the one for the directory you work in.`,
		);
	}
	for (const file of files.filter((f) => f.cut)) {
		parts.push(
			`[pi-action: ${file.path} was cut at the context_files_max_bytes limit of ${maxBytes} bytes; read it for the rest.]`,
		);
	}
	if (skipped.length > 0) {
		parts.push(
			`[pi-action: not loaded, at the context_files_max_bytes limit: ${skipped.join(", ")}. Read them with your tools.]`,
		);
	}
	if (base !== undefined) {
		parts.push(
			`This pull request comes from a fork, so the repository's files above are from its base commit ${base.slice(0, 7)}, not from the pull request.`,
		);
	}
	return parts.join("\n\n");
}

/** The workspace's files: from the checkout, or from a fork pull request's base commit (undefined: none). */
async function openSource(
	options: ContextFilesOptions,
	root: string,
): Promise<{ source: Source | undefined; base: string | undefined }> {
	const { base, log } = options;
	if (base === undefined) {
		return { source: checkoutSource(root), base: undefined };
	}
	const source = await commitSource(root, base.sha, base.remote, log);
	if (source === undefined) {
		log.warning(
			"Context files: not loading the repository's context files, because this pull request comes from a fork and its base commit is not available",
		);
		return { source, base: undefined };
	}
	log.info(
		`Context files: this pull request comes from a fork, so they are read from its base commit ${base.sha.slice(0, 7)}`,
	);
	return { source, base: base.sha };
}

interface FoundFile {
	path: string;
	label: string;
	content: string;
}

/** The global context file in `agentDir`; from `source` when the directory is in the workspace. */
async function globalFile(
	agentDir: string,
	root: string,
	source: Source | undefined,
): Promise<FoundFile | undefined> {
	const inWorkspace = source !== undefined && isInside(root, agentDir);
	const file = inWorkspace
		? await firstContextFile(source.read, toPosix(relative(root, agentDir)))
		: await firstContextFile(
				async (rel) => readOptional(join(agentDir, rel)),
				"",
			);
	return file === undefined
		? undefined
		: {
				path: join(agentDir, basename(file.rel)),
				label: `agent_dir/${basename(file.rel)}`,
				content: file.content,
			};
}

/** The workspace's context files from the root down to `cwd`, in order. */
async function workspaceFiles(
	source: Source,
	root: string,
	dirs: readonly string[],
): Promise<FoundFile[]> {
	const files = await Promise.all(
		dirs.map(async (dir) => firstContextFile(source.read, dir)),
	);
	return files.flatMap((file) =>
		file === undefined
			? []
			: [
					{
						path: join(root, file.rel),
						label: file.rel,
						content: file.content,
					},
				],
	);
}

/** The files within `maxBytes` in total, without invisible characters: the one at the limit cut, later ones skipped. */
function applyLimit(
	found: readonly FoundFile[],
	maxBytes: number,
): { files: ContextFile[]; skipped: string[] } {
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
			files.push({
				path,
				label,
				content: cutUtf8(content, left),
				bytes,
				cut: true,
			});
			left = 0;
		}
	}
	return { files, skipped };
}

/** The setup log: what was loaded, and a warning for what was cut or left out. */
function logContext(
	context: Omit<ProjectContext, "text">,
	maxBytes: number,
	log: Log,
): void {
	const { files, skipped, nested } = context;
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
	const loaded = files.map(
		(file) =>
			`${file.label} (${formatBytes(file.bytes)}${file.cut ? ", cut" : ""})`,
	);
	const listed = nested.length > 0 ? `; ${nested.length} more listed` : "";
	log.info(`Context files: ${loaded.join(", ") || "none"}${listed}`);
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
	const { source, base } = await openSource(options, root);
	const dirs = directoriesDown(root, cwd);
	const [global, local, nested] = await Promise.all([
		agentDir === undefined ? undefined : globalFile(agentDir, root, source),
		source === undefined ? [] : workspaceFiles(source, root, dirs),
		source === undefined ? [] : source.list(dirs.at(-1) ?? ""),
	]);
	const { files, skipped } = applyLimit(
		// agent_dir may be one of the directories, such as the root: its file comes once, first.
		[
			...(global === undefined ? [] : [global]),
			...local.filter((file) => file.path !== global?.path),
		],
		maxBytes,
	);
	const context = { files, skipped, nested: nestedFiles(nested), base };
	logContext(context, maxBytes, log);
	return { ...context, text: renderProjectContext(context, maxBytes) };
}
