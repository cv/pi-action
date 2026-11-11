// Vendored from github.com/cv/git-backed-pi-durable (1b9ba48). Edit there, then copy.
// Moving a GitStorage ref between a local repository and a remote: fetch it before opening, push it as it grows.
import { execFile } from "node:child_process";
import type { Batch } from "./git-storage.js";
import { assertRefName } from "./git.js";

export class GitSyncConflictError extends Error {
	readonly ref: string;
	constructor(ref: string, detail: string) {
		super(`Push of ${ref} was rejected (another writer moved it): ${detail}`);
		this.name = "GitSyncConflictError";
		this.ref = ref;
	}
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export interface GitSyncOptions {
	/** The work tree (or git dir) to run git in. */
	readonly repo: string;
	readonly ref: string;
	/** Default "origin". */
	readonly remote?: string;
	readonly log?: (message: string) => void;
	/** Runs git; injectable for tests. Rejects with { stdout, stderr } attached on a nonzero exit. */
	readonly git?: GitRunner;
}

const MESSAGE_KINDS = new Set(["pi.assistant", "pi.tool-result"]);

/** A model response or tool result was stored: the end of a turn (or of one of its tool calls). */
export function isTurnBoundary(batches: readonly Batch[]): boolean {
	return batches.some((batch) =>
		batch.writes.some((write) => write.type === "entry" && MESSAGE_KINDS.has(write.value.kind)),
	);
}

/**
 * Pushes are fast-forward only, so a concurrent writer on the same ref makes the later push fail
 * (GitSyncConflictError) instead of overwriting the other's history. Pushes are coalesced: at most one runs,
 * and the newest scheduled tip goes next.
 */
export class GitSync {
	readonly ref: string;
	readonly remote: string;
	private readonly repo: string;
	private readonly log: (message: string) => void;
	private readonly git: GitRunner;
	/** What the remote ref is known to point at. */
	private remoteTip: string | undefined;
	private wanted: string | undefined;
	private running: Promise<void> | undefined;
	private failure: Error | undefined;

	constructor(options: GitSyncOptions) {
		assertRefName(options.ref);
		this.repo = options.repo;
		this.ref = options.ref;
		this.remote = options.remote ?? "origin";
		this.log = options.log ?? (() => {});
		this.git = options.git ?? runGit;
	}

	/** The remote tip as of the last fetch or push. */
	get pushed(): string | undefined {
		return this.remoteTip;
	}

	/** The error that stopped pushing, if any. */
	get error(): Error | undefined {
		return this.failure;
	}

	/**
	 * Make the local ref equal the remote one (creating, moving, or deleting it). Returns the remote tip, undefined
	 * when the remote has no such ref yet.
	 */
	async fetch(): Promise<string | undefined> {
		const { stdout } = await this.git(["ls-remote", "--refs", this.remote, this.ref], this.repo);
		const line = stdout.split("\n").find((l) => l.endsWith(`\t${this.ref}`));
		const tip = line?.split("\t")[0];
		if (tip === undefined) {
			await this.git(["update-ref", "-d", this.ref], this.repo).catch(() => {});
			this.log(`${this.ref}: new on ${this.remote}`);
		} else {
			await this.git(
				["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", this.remote, `+${this.ref}:${this.ref}`],
				this.repo,
			);
			this.log(`${this.ref}: fetched ${tip.slice(0, 7)}`);
		}
		this.remoteTip = tip;
		return tip;
	}

	/** Push `tip` soon; resolves when it (or a newer scheduled tip) is pushed. */
	schedule(tip: string): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		this.wanted = tip;
		this.running ??= this.drain().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Push `tip` now (after any push in flight); throws why pushing stopped, if it did. */
	async flush(tip: string | undefined): Promise<void> {
		if (this.running) await this.running.catch(() => {});
		if (this.failure) throw this.failure;
		if (tip !== undefined && tip !== this.remoteTip) await this.schedule(tip);
	}

	private async drain(): Promise<void> {
		while (this.wanted !== undefined && this.wanted !== this.remoteTip) {
			const tip = this.wanted;
			try {
				await this.git(["push", "--quiet", "--no-verify", this.remote, `${tip}:${this.ref}`], this.repo);
			} catch (error) {
				const detail = String((error as { stderr?: string }).stderr || error).trim();
				this.failure = /rejected|non-fast-forward|fetch first|stale info/i.test(detail)
					? new GitSyncConflictError(this.ref, detail)
					: new Error(`Push of ${this.ref} failed: ${detail}`);
				throw this.failure;
			}
			this.remoteTip = tip;
			this.log(`${this.ref}: pushed ${tip.slice(0, 7)}`);
		}
	}
}

export const runGit: GitRunner = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
	});
