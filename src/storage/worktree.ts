// Working-tree snapshots: what pi left uncommitted, saved in git's own stash format and restored in a later run.
//
// A snapshot is a stash commit W (tree of the tracked files on disk) with parents [HEAD, I, U?]: I holds the index,
// U the untracked files that are not ignored. They are built in temporary index files, so the real index and the
// working tree are never touched, and `git stash show -p --include-untracked <W>` / `git stash apply --index <W>`
// work on them. Snapshots are kept on `refs/pi/worktrees/<n>` as a chain of wrapper commits with parents
// [previous wrapper, W], so every snapshot (and every local commit it builds on) stays reachable from one ref.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertRefName, git, GitError } from "./git.ts";

export const worktreeRef = (issueNumber: number): string =>
	`refs/pi/worktrees/${issueNumber}`;

const MB = 1024 * 1024;
const AUTHOR = {
	name: "pi-action",
	email: "pi-action@users.noreply.github.com",
} as const;
const DETACHED = "(detached)";
const TRAILER_PATTERN = /^([A-Za-z-]+): (.*)$/u;
const GLOB_SPECIAL = /[.+^${}()|[\]\\]/gu;
const NUL = "\0";

/** What a snapshot leaves out of the untracked files (ignored files are never captured). */
export interface SnapshotLimits {
	/** Untracked files larger than this are skipped. */
	readonly maxFileBytes: number;
	/** Untracked files past this total are skipped. */
	readonly maxTotalBytes: number;
	/** Globs of untracked files to skip: a pattern without `/` matches the file name, one with `/` the whole path. */
	readonly exclude: readonly string[];
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
	maxFileBytes: 10 * MB,
	maxTotalBytes: 100 * MB,
	exclude: [],
};

/** An untracked file a snapshot left out, and why. */
export interface Skipped {
	readonly path: string;
	readonly reason: string;
}

/** The working tree as git trees: what a snapshot of it would hold. */
export interface WorktreeState {
	readonly head: string;
	/** Undefined for a detached HEAD. */
	readonly branch: string | undefined;
	readonly headTree: string;
	readonly indexTree: string;
	readonly worktreeTree: string;
	/** Undefined when there are no untracked files to keep. */
	readonly untrackedTree: string | undefined;
	readonly skipped: readonly Skipped[];
}

/** A snapshot on the ref: its wrapper commit, its stash commit W, and the trailers of the wrapper. */
export interface SnapshotRecord {
	readonly wrapper: string;
	readonly stash: string;
	readonly head: string;
	readonly branch: string | undefined;
	readonly threadTip: string | undefined;
	readonly threadEntry: string | undefined;
	readonly skipped: readonly Skipped[];
}

interface RunOptions {
	readonly env?: Readonly<Record<string, string>>;
	readonly input?: string;
}

/** Run git with extra environment variables and stdin; resolves with stdout, rejects with a GitError. */
async function run(
	dir: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", dir, ...args], {
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => {
			out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err.push(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const stdout = Buffer.concat(out).toString("utf8");
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(
					new GitError(
						args,
						Buffer.concat(err).toString("utf8") || stdout || `exit ${code}`,
					),
				);
			}
		});
		// git may exit without reading its input (a command that takes none, or a failure).
		child.stdin.on("error", () => undefined);
		child.stdin.end(options.input ?? "");
	});
}

const trim = async (promise: Promise<string>): Promise<string> =>
	(await promise).trim();

/** The output of a git command, undefined when it fails. */
async function maybe(
	dir: string,
	args: readonly string[],
): Promise<string | undefined> {
	try {
		return (await git(dir, args)).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Whether git exits 0. */
async function succeeds(
	dir: string,
	args: readonly string[],
): Promise<boolean> {
	try {
		await git(dir, args);
		return true;
	} catch {
		return false;
	}
}

const toplevel = async (cwd: string): Promise<string> =>
	trim(git(cwd, ["rev-parse", "--show-toplevel"]));

const currentBranch = async (dir: string): Promise<string | undefined> =>
	maybe(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);

/** `*` and `?` within a path segment, `**` across them. */
function globPattern(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i += 1) {
		const ch = glob.charAt(i);
		if (ch === "*" && glob.charAt(i + 1) === "*") {
			source += ".*";
			i += 1;
		} else if (ch === "*") {
			source += "[^/]*";
		} else if (ch === "?") {
			source += "[^/]";
		} else {
			source += ch.replaceAll(GLOB_SPECIAL, String.raw`\$&`);
		}
	}
	return new RegExp(`^${source}$`, "u");
}

/** Whether `path` matches one of the `exclude` globs. */
export function isExcluded(path: string, exclude: readonly string[]): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return exclude.some((glob) => {
		const pattern = globPattern(glob.trim());
		return glob.includes("/") ? pattern.test(path) : pattern.test(name);
	});
}

const megabytes = (bytes: number): string =>
	`${Math.round((bytes / MB) * 10) / 10} MB`;

/** The untracked files a snapshot keeps, and those it skips. */
async function untrackedFiles(
	top: string,
	limits: SnapshotLimits,
): Promise<{ keep: string[]; skipped: Skipped[] }> {
	const listed = (
		await git(top, ["ls-files", "--others", "--exclude-standard", "-z"])
	)
		.split(NUL)
		.filter(Boolean);
	const keep: string[] = [];
	const skipped: Skipped[] = [];
	let total = 0;
	const stats = await Promise.all(
		listed.map(async (path) =>
			fs.lstat(join(top, path)).catch(() => undefined),
		),
	);
	for (const [index, path] of listed.entries()) {
		const stat = stats[index];
		const size = stat?.isFile() === true ? stat.size : 0;
		if (path.endsWith("/")) {
			skipped.push({ path, reason: "a nested git repository" });
		} else if (stat === undefined) {
			// deleted while we looked
		} else if (isExcluded(path, limits.exclude)) {
			skipped.push({ path, reason: "matches worktree_snapshot_exclude" });
		} else if (size > limits.maxFileBytes) {
			skipped.push({
				path,
				reason: `${megabytes(size)}, over the ${megabytes(limits.maxFileBytes)} limit for a file`,
			});
		} else if (total + size > limits.maxTotalBytes) {
			skipped.push({
				path,
				reason: `over the ${megabytes(limits.maxTotalBytes)} limit for a snapshot`,
			});
		} else {
			total += size;
			keep.push(path);
		}
	}
	return { keep, skipped };
}

/**
 * The working tree of the repository at `cwd` as trees: the index, the tracked files on disk, and the untracked
 * files that are not ignored (within `limits`). Writes blobs and trees, never the real index or working tree.
 */
export async function captureState(
	cwd: string,
	limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<WorktreeState> {
	const top = await toplevel(cwd);
	const [head, branch, realIndex] = await Promise.all([
		trim(git(top, ["rev-parse", "--verify", "HEAD^{commit}"])),
		currentBranch(top),
		trim(
			git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
		),
	]);
	const headTree = await trim(git(top, ["rev-parse", `${head}^{tree}`]));
	const tmp = await fs.mkdtemp(join(tmpdir(), "pi-action-snapshot-"));
	try {
		const index = join(tmp, "index");
		const env = { GIT_INDEX_FILE: index };
		const copied = await fs
			.copyFile(realIndex, index)
			.then(() => true)
			.catch(() => false);
		if (!copied) {
			await run(top, ["read-tree", head], { env });
		}
		const indexTree = await trim(run(top, ["write-tree"], { env })).catch(
			async () => {
				// Unmerged entries: keep HEAD's tree for the index, the files on disk still count.
				await run(top, ["read-tree", head], { env });
				return headTree;
			},
		);
		await run(top, ["add", "--update", "--", ":/"], { env });
		const worktreeTree = await trim(run(top, ["write-tree"], { env }));
		const { keep, skipped } = await untrackedFiles(top, limits);
		let untrackedTree: string | undefined;
		if (keep.length > 0) {
			const uenv = { GIT_INDEX_FILE: join(tmp, "untracked") };
			await run(
				top,
				[
					"--literal-pathspecs",
					"add",
					"--pathspec-from-file=-",
					"--pathspec-file-nul",
				],
				{ env: uenv, input: keep.join(NUL) },
			);
			untrackedTree = await trim(run(top, ["write-tree"], { env: uenv }));
		}
		return {
			head,
			branch,
			headTree,
			indexTree,
			worktreeTree,
			untrackedTree,
			skipped,
		};
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

/** What tells two states apart: the commit, the branch, and the three trees. */
export function stateKey(
	state: Pick<
		WorktreeState,
		"head" | "branch" | "indexTree" | "worktreeTree" | "untrackedTree"
	>,
): string {
	return [
		state.head,
		state.branch ?? DETACHED,
		state.indexTree,
		state.worktreeTree,
		state.untrackedTree ?? "-",
	].join(" ");
}

/** Nothing uncommitted: the index and the files match HEAD, and there are no untracked files. */
export function isClean(state: WorktreeState): boolean {
	return (
		state.indexTree === state.headTree &&
		state.worktreeTree === state.headTree &&
		state.untrackedTree === undefined
	);
}

const COMMIT_ENV = {
	GIT_AUTHOR_NAME: AUTHOR.name,
	GIT_AUTHOR_EMAIL: AUTHOR.email,
	GIT_COMMITTER_NAME: AUTHOR.name,
	GIT_COMMITTER_EMAIL: AUTHOR.email,
};

async function commitTree(
	dir: string,
	tree: string,
	parents: readonly string[],
	message: string,
): Promise<string> {
	return trim(
		run(dir, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])], {
			env: COMMIT_ENV,
			input: message,
		}),
	);
}

/** The stash commit W for `state`, with its I (and U) commits, as `git stash` would make them. */
export async function writeStash(
	cwd: string,
	state: WorktreeState,
): Promise<string> {
	const subject = (
		await git(cwd, ["log", "-1", "--format=%h %s", state.head])
	).trim();
	const on = `${state.branch ?? "(no branch)"}: ${subject}`;
	const index = await commitTree(
		cwd,
		state.indexTree,
		[state.head],
		`index on ${on}\n`,
	);
	const untracked =
		state.untrackedTree === undefined
			? []
			: [
					await commitTree(
						cwd,
						state.untrackedTree,
						[],
						`untracked files on ${on}\n`,
					),
				];
	return commitTree(
		cwd,
		state.worktreeTree,
		[state.head, index, ...untracked],
		`WIP on ${on}\n`,
	);
}

/** The state a stash commit holds (the branch comes from its wrapper). */
export async function stashState(
	cwd: string,
	stash: string,
	branch: string | undefined,
): Promise<Omit<WorktreeState, "skipped" | "headTree">> {
	const parents = (await git(cwd, ["rev-list", "--parents", "-n", "1", stash]))
		.trim()
		.split(" ")
		.slice(1);
	const [head = "", index = "", untracked] = parents;
	const tree = async (commit: string) =>
		trim(git(cwd, ["rev-parse", `${commit}^{tree}`]));
	return {
		head,
		branch,
		indexTree: await tree(index),
		worktreeTree: await tree(stash),
		untrackedTree: untracked === undefined ? undefined : await tree(untracked),
	};
}

export interface RecordInput {
	readonly stash: string;
	readonly head: string;
	readonly branch: string | undefined;
	readonly skipped: readonly Skipped[];
	readonly threadTip?: string | undefined;
	readonly threadEntry?: string | undefined;
}

function wrapperMessage(input: RecordInput): string {
	const trailers = [
		`Snapshot: ${input.stash}`,
		...(input.threadTip ? [`Thread-Tip: ${input.threadTip}`] : []),
		...(input.threadEntry ? [`Thread-Entry: ${input.threadEntry}`] : []),
		`Branch: ${input.branch ?? DETACHED}`,
		`Head: ${input.head}`,
		...input.skipped.map((skip) => `Skipped: ${JSON.stringify(skip)}`),
	];
	return `pi-action: working-tree snapshot ${input.stash.slice(0, 7)}\n\n${trailers.join("\n")}\n`;
}

/**
 * Add a snapshot to `ref`: a wrapper commit with parents [previous wrapper, W] and W's tree, moved by
 * compare-and-swap from the previous tip. Returns the new record.
 */
export async function recordSnapshot(
	cwd: string,
	ref: string,
	input: RecordInput,
): Promise<SnapshotRecord> {
	assertRefName(ref);
	const previous = await maybe(cwd, ["rev-parse", "-q", "--verify", ref]);
	const tree = await trim(git(cwd, ["rev-parse", `${input.stash}^{tree}`]));
	const wrapper = await commitTree(
		cwd,
		tree,
		[...(previous ? [previous] : []), input.stash],
		wrapperMessage(input),
	);
	await git(cwd, ["update-ref", ref, wrapper, previous ?? ""]);
	return {
		wrapper,
		stash: input.stash,
		head: input.head,
		branch: input.branch,
		threadTip: input.threadTip,
		threadEntry: input.threadEntry,
		skipped: input.skipped,
	};
}

function parseSkipped(value: string): Skipped[] {
	try {
		const parsed: unknown = JSON.parse(value);
		const path: unknown =
			typeof parsed === "object" && parsed !== null
				? Reflect.get(parsed, "path")
				: undefined;
		const reason: unknown =
			typeof parsed === "object" && parsed !== null
				? Reflect.get(parsed, "reason")
				: undefined;
		return typeof path === "string" && typeof reason === "string"
			? [{ path, reason }]
			: [];
	} catch {
		return [];
	}
}

/** The snapshot a wrapper commit records. */
export async function readSnapshot(
	cwd: string,
	wrapper: string,
): Promise<SnapshotRecord> {
	const body = await git(cwd, ["log", "-1", "--format=%B", wrapper]);
	const trailers = new Map<string, string>();
	const skipped: Skipped[] = [];
	for (const line of body.split("\n")) {
		const [, key, value = ""] = TRAILER_PATTERN.exec(line) ?? [];
		if (key === "Skipped") {
			skipped.push(...parseSkipped(value));
		} else if (key !== undefined) {
			trailers.set(key, value);
		}
	}
	const stash =
		trailers.get("Snapshot") ??
		(await trim(git(cwd, ["rev-parse", `${wrapper}^2`])));
	const head =
		trailers.get("Head") ?? (await trim(git(cwd, ["rev-parse", `${stash}^1`])));
	const branch = trailers.get("Branch");
	return {
		wrapper,
		stash,
		head,
		branch: branch === DETACHED ? undefined : branch,
		threadTip: trailers.get("Thread-Tip"),
		threadEntry: trailers.get("Thread-Entry"),
		skipped,
	};
}

/** The newest snapshot on `ref`; undefined when it has none. */
export async function latestSnapshot(
	cwd: string,
	ref: string,
): Promise<SnapshotRecord | undefined> {
	assertRefName(ref);
	const tip = await maybe(cwd, ["rev-parse", "-q", "--verify", ref]);
	return tip === undefined ? undefined : readSnapshot(cwd, tip);
}

/** Paths and blob ids of a raw `diff-tree -z` that added or changed files. */
async function changedBlobs(
	cwd: string,
	from: string,
	to: string,
): Promise<[string, string][]> {
	const out = await git(cwd, [
		"diff-tree",
		"-r",
		"-z",
		"--no-renames",
		"--diff-filter=AMT",
		from,
		to,
	]);
	const fields = out.split(NUL);
	const result: [string, string][] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const blob = fields[i]?.split(" ")[3];
		const path = fields[i + 1];
		if (blob !== undefined && path !== undefined) {
			result.push([path, blob]);
		}
	}
	return result;
}

/** path -> blob ids of every file in a tree (`ls-tree -r`), limited to `paths`. */
async function blobsAt(
	cwd: string,
	tree: string,
	paths: readonly string[],
): Promise<[string, string][]> {
	if (paths.length === 0) {
		return [];
	}
	const out = await git(cwd, [
		"--literal-pathspecs",
		"ls-tree",
		"-r",
		"-z",
		tree,
		"--",
		...paths,
	]);
	return out
		.split(NUL)
		.filter(Boolean)
		.flatMap((line) => {
			const tab = line.indexOf("\t");
			const blob = line.slice(0, tab).split(" ").at(2);
			return blob === undefined ? [] : [[line.slice(tab + 1), blob]];
		});
}

/** The content (path -> blob ids) a stash adds over its HEAD: index, files on disk, untracked files. */
async function stashContent(
	cwd: string,
	stash: string,
): Promise<Map<string, Set<string>>> {
	const state = await stashState(cwd, stash, undefined);
	const content = new Map<string, Set<string>>();
	const add = ([path, blob]: [string, string]) => {
		const blobs = content.get(path) ?? new Set<string>();
		blobs.add(blob);
		content.set(path, blobs);
	};
	for (const change of [
		...(await changedBlobs(cwd, state.head, state.indexTree)),
		...(await changedBlobs(cwd, state.head, state.worktreeTree)),
	]) {
		add(change);
	}
	if (state.untrackedTree !== undefined) {
		const out = await git(cwd, [
			"ls-tree",
			"-r",
			"-z",
			"--format=%(objectname)\t%(path)",
			state.untrackedTree,
		]);
		for (const line of out.split(NUL).filter(Boolean)) {
			const [blob = "", path = ""] = line.split("\t");
			add([path, blob]);
		}
	}
	return content;
}

/** Work in `latest` that exists nowhere else: changed files, and local commits. */
export interface UniqueWork {
	readonly files: readonly string[];
	readonly commits: readonly string[];
}

/** Commits reachable from a remote branch, by the tips this repository has. */
async function remoteTipsHere(cwd: string, remote: string): Promise<string[]> {
	const out = await git(cwd, ["ls-remote", "--heads", remote]).catch(() => "");
	const tips = out
		.split("\n")
		.map((line) => line.split("\t")[0] ?? "")
		.filter(Boolean);
	const present = await Promise.all(
		tips.map(async (tip) =>
			succeeds(cwd, ["cat-file", "-e", `${tip}^{commit}`]),
		),
	);
	return tips.filter((_tip, i) => present[i] === true);
}

/**
 * The work in `latest` that restoring `target` (or a clean checkout, when undefined) would leave only on the
 * snapshot ref: files whose content in `latest` the target has nowhere (its index, files, untracked files, or
 * commit), and commits not reachable from the target, the current HEAD, or any remote branch.
 */
export async function uniqueWork(
	cwd: string,
	latest: SnapshotRecord,
	target: SnapshotRecord | undefined,
	remote = "origin",
): Promise<UniqueWork> {
	const content = await stashContent(cwd, latest.stash);
	const paths = [...content.keys()];
	const kept = new Map<string, Set<string>>();
	const keep = ([path, blob]: [string, string]) => {
		const blobs = kept.get(path) ?? new Set<string>();
		blobs.add(blob);
		kept.set(path, blobs);
	};
	const head = await trim(git(cwd, ["rev-parse", "HEAD"]));
	const trees = [head];
	if (target !== undefined) {
		const state = await stashState(cwd, target.stash, target.branch);
		trees.push(state.head, state.indexTree, state.worktreeTree);
		if (state.untrackedTree !== undefined) {
			trees.push(state.untrackedTree);
		}
	}
	for (const tree of trees) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- a handful of trees
		for (const blob of await blobsAt(cwd, tree, paths)) {
			keep(blob);
		}
	}
	const files = paths
		.filter((path) =>
			[...(content.get(path) ?? [])].some(
				(blob) => kept.get(path)?.has(blob) !== true,
			),
		)
		.toSorted();
	const exclude = [
		head,
		...(target ? [target.head] : []),
		...(await remoteTipsHere(cwd, remote)),
	];
	const commits = (
		await git(cwd, [
			"rev-list",
			latest.head,
			"--not",
			`--remotes=${remote}`,
			...exclude,
		])
	)
		.split("\n")
		.filter(Boolean);
	return { files, commits };
}

/** How a restore went. */
export type RestoreOutcome =
	| {
			readonly status: "restored";
			/** Whether the index was restored too (false: the changes are all unstaged). */
			readonly staged: boolean;
			/** Files left with conflict markers. */
			readonly conflicts: readonly string[];
			/** Where HEAD is now. */
			readonly branch: string | undefined;
			readonly head: string;
			/** The remote branch had moved past the snapshot's HEAD: the snapshot was merged onto it. */
			readonly moved: boolean;
	  }
	| {
			readonly status: "diverged";
			readonly branch: string;
			readonly head: string;
			readonly remoteHead: string;
	  }
	| { readonly status: "failed"; readonly error: string };

async function isShallow(cwd: string): Promise<boolean> {
	return (
		(await maybe(cwd, ["rev-parse", "--is-shallow-repository"])) === "true"
	);
}

const isAncestor = async (
	cwd: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> =>
	succeeds(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);

/**
 * Fetch `branch` from the remote into its remote-tracking ref. In a shallow clone, fetch its history back to a day
 * before `since`'s commit, so ancestry checks against `since` can see it.
 */
async function fetchBranch(
	cwd: string,
	remote: string,
	branch: string,
	since: string,
): Promise<string> {
	const tracking = `refs/remotes/${remote}/${branch}`;
	const deepen = (await isShallow(cwd))
		? [
				`--shallow-since=${Number(await trim(git(cwd, ["log", "-1", "--format=%ct", since]))) - 86_400}`,
			]
		: [];
	await git(cwd, [
		"fetch",
		"--quiet",
		"--no-tags",
		...deepen,
		remote,
		`+refs/heads/${branch}:${tracking}`,
	]);
	return trim(git(cwd, ["rev-parse", tracking]));
}

/** HEAD where the snapshot can apply, or why not (the branch diverged). */
async function placeHead(
	cwd: string,
	record: SnapshotRecord,
	remote: string,
): Promise<
	| { kind: "placed"; moved: boolean }
	| { kind: "diverged"; branch: string; remoteHead: string }
> {
	const { branch, head } = record;
	const current = await trim(git(cwd, ["rev-parse", "HEAD"]));
	if (branch === undefined) {
		if (!(await isAncestor(cwd, head, current))) {
			await git(cwd, ["checkout", "--quiet", "--detach", head]);
		}
		return { kind: "placed", moved: false };
	}
	const listed = await git(cwd, [
		"ls-remote",
		"--heads",
		remote,
		`refs/heads/${branch}`,
	]);
	const remoteHead = listed.split("\t")[0]?.trim();
	if (!remoteHead) {
		// A branch only the earlier run had: recreate it.
		await git(cwd, ["checkout", "--quiet", "-B", branch, head]);
		return { kind: "placed", moved: false };
	}
	if (
		(await currentBranch(cwd)) === branch &&
		(await isAncestor(cwd, head, current))
	) {
		return { kind: "placed", moved: current !== head };
	}
	const fetched = await fetchBranch(cwd, remote, branch, head);
	if (fetched === head || (await isAncestor(cwd, head, fetched))) {
		await git(cwd, [
			"checkout",
			"--quiet",
			"-B",
			branch,
			`${remote}/${branch}`,
		]);
		return { kind: "placed", moved: fetched !== head };
	}
	if (await isAncestor(cwd, fetched, head)) {
		// Local commits on top of the remote branch.
		await git(cwd, ["checkout", "--quiet", "-B", branch, head]);
		await git(cwd, [
			"branch",
			"--quiet",
			`--set-upstream-to=${remote}/${branch}`,
		]).catch(() => undefined);
		return { kind: "placed", moved: false };
	}
	return { kind: "diverged", branch, remoteHead: fetched };
}

const unmergedFiles = async (cwd: string): Promise<string[]> =>
	(await git(cwd, ["diff", "--name-only", "-z", "--diff-filter=U"]))
		.split(NUL)
		.filter(Boolean);

/** The untracked files a stash holds that are not on disk yet: those a failed restore must remove. */
async function newUntracked(cwd: string, stash: string): Promise<string[]> {
	const untracked = await maybe(cwd, [
		"rev-parse",
		"-q",
		"--verify",
		`${stash}^3`,
	]);
	if (untracked === undefined) {
		return [];
	}
	const top = await toplevel(cwd);
	const paths = (
		await git(cwd, ["ls-tree", "-r", "-z", "--name-only", untracked])
	)
		.split(NUL)
		.filter(Boolean);
	const present = await Promise.all(
		paths.map(async (path) =>
			fs
				.lstat(join(top, path))
				.then(() => true)
				.catch(() => false),
		),
	);
	return paths
		.filter((_path, i) => present[i] !== true)
		.map((path) => join(top, path));
}

/** Back to the checkout the run started with: the original HEAD, no changes, the files the restore added gone. */
async function startClean(
	cwd: string,
	original: { head: string; branch: string | undefined },
	added: readonly string[],
): Promise<void> {
	await git(cwd, ["reset", "--quiet", "--hard"]).catch(() => undefined);
	await git(cwd, [
		"checkout",
		"--quiet",
		"--force",
		original.branch ?? original.head,
	]).catch(() => undefined);
	await Promise.all(
		added.map(async (path) =>
			fs.rm(path, { force: true }).catch(() => undefined),
		),
	);
}

/** `git stash apply --index`, else without `--index`; conflicts are left in place. */
async function applyStash(
	cwd: string,
	stash: string,
): Promise<{ staged: boolean; conflicts: string[] }> {
	try {
		await git(cwd, ["stash", "apply", "--quiet", "--index", stash]);
		return { staged: true, conflicts: [] };
	} catch (error) {
		const conflicts = await unmergedFiles(cwd);
		if (conflicts.length > 0) {
			return { staged: false, conflicts };
		}
		const dirty = await git(cwd, ["status", "--porcelain"]);
		if (dirty.trim() !== "") {
			throw error;
		}
	}
	try {
		await git(cwd, ["stash", "apply", "--quiet", stash]);
		return { staged: false, conflicts: [] };
	} catch (error) {
		const conflicts = await unmergedFiles(cwd);
		if (conflicts.length > 0) {
			return { staged: false, conflicts };
		}
		throw error;
	}
}

/**
 * Restore a snapshot into the checkout at `cwd` (which should be clean): put HEAD on the snapshot's branch (recreate a
 * local-only branch, follow a remote branch that moved ahead, refuse one that diverged), then apply the stash like
 * `git stash apply --index`, without the index if that fails, leaving conflict markers. Never throws: a failure
 * puts the checkout back as it was.
 */
export async function restoreSnapshot(
	cwd: string,
	record: SnapshotRecord,
	remote = "origin",
): Promise<RestoreOutcome> {
	const original = {
		head: await trim(git(cwd, ["rev-parse", "HEAD"])),
		branch: await currentBranch(cwd),
	};
	const added = await newUntracked(cwd, record.stash).catch(() => []);
	try {
		const placed = await placeHead(cwd, record, remote);
		if (placed.kind === "diverged") {
			return {
				status: "diverged",
				branch: placed.branch,
				head: record.head,
				remoteHead: placed.remoteHead,
			};
		}
		const applied = await applyStash(cwd, record.stash);
		return {
			status: "restored",
			...applied,
			branch: await currentBranch(cwd),
			head: await trim(git(cwd, ["rev-parse", "HEAD"])),
			moved: placed.moved,
		};
	} catch (error) {
		await startClean(cwd, original, added);
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
