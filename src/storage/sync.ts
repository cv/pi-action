// Moving a GitStorage ref between a local repository and a remote: fetch it before opening, push it as it grows.
import { setTimeout as sleep } from "node:timers/promises";

import type { Batch } from "./git-storage.ts";
import { assertRefName, git, GitError } from "./git.ts";

export class GitSyncConflictError extends Error {
	readonly ref: string;
	constructor(ref: string, detail: string) {
		super(`Push of ${ref} was rejected (another writer moved it): ${detail}`);
		this.name = "GitSyncConflictError";
		this.ref = ref;
	}
}

/** Runs git in a directory and resolves with its stdout, like `git()`; tests replace it. */
export type GitRunner = (
	dir: string,
	args: readonly string[],
) => Promise<string>;

export interface GitSyncOptions {
	/** The work tree (or git dir) to run git in. */
	readonly repo: string;
	readonly ref: string;
	/** Default "origin". */
	readonly remote?: string | undefined;
	readonly log?: (message: string) => void;
	/**
	 * How long to wait before each retry of a push that failed for another reason than a conflict (a GitHub-side
	 * `[remote rejected] ... (failed)`, a network error); its length is the number of retries. Default 1 s, 3 s, 10 s.
	 */
	readonly retryDelaysMs?: readonly number[] | undefined;
	/** Default `git()`. */
	readonly git?: GitRunner | undefined;
}

const RETRY_DELAYS_MS = [1000, 3000, 10_000] as const;
/**
 * git push's status line for a ref the remote refused because the push is not a fast-forward of what it has
 * (` ! [rejected]        <src> -> <ref> (fetch first)`, `(non-fast-forward)`, or `(stale info)` for a lease).
 * Anything else, such as ` ! [remote rejected] <src> -> <ref> (failed)`, is not a conflict and may pass.
 */
const CONFLICT_PATTERN =
	/^\s*!\s*\[rejected\]\s.*\((?:fetch first|non-fast-forward|stale info)\)\s*$/mu;
const MESSAGE_KINDS = new Set(["pi.assistant", "pi.tool-result"]);

/** A model response or tool result was stored: the end of a turn (or of one of its tool calls). */
export function isTurnBoundary(batches: readonly Batch[]): boolean {
	return batches.some((batch) =>
		batch.writes.some(
			(write) => write.type === "entry" && MESSAGE_KINDS.has(write.value.kind),
		),
	);
}

/**
 * Pushes are fast-forward only, so a concurrent writer on the same ref makes the later push fail
 * (GitSyncConflictError) instead of overwriting the other's history; that stops pushing for good. Other failures
 * are retried a few times, then reported to the callers waiting on that push, and the next schedule or flush tries
 * again. Pushes are coalesced: at most one runs, and the newest scheduled tip goes next.
 */
export class GitSync {
	readonly ref: string;
	readonly remote: string;
	private readonly repo: string;
	private readonly log: (message: string) => void;
	/** What the remote ref is known to point at. */
	private remoteTip: string | undefined;
	private wanted: string | undefined;
	private running: Promise<void> | undefined;
	/** Why pushing stopped for good: another writer moved the remote ref. */
	private failure: GitSyncConflictError | undefined;
	private readonly retryDelaysMs: readonly number[];
	private readonly git: GitRunner;

	constructor(options: GitSyncOptions) {
		assertRefName(options.ref);
		this.repo = options.repo;
		this.ref = options.ref;
		this.remote = options.remote ?? "origin";
		this.log = options.log ?? (() => undefined);
		this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
		this.git = options.git ?? git;
	}

	/**
	 * Make the local ref equal the remote one (creating, moving, or deleting it). Returns the remote tip, undefined
	 * when the remote has no such ref yet.
	 */
	async fetch(): Promise<string | undefined> {
		const tip = await this.remoteHead();
		if (tip === undefined) {
			await this.git(this.repo, ["update-ref", "-d", this.ref]).catch(
				() => undefined,
			);
			this.log(`${this.ref}: new on ${this.remote}`);
		} else {
			await this.git(this.repo, [
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				this.remote,
				`+${this.ref}:${this.ref}`,
			]);
			this.log(`${this.ref}: fetched ${tip.slice(0, 7)}`);
		}
		return tip;
	}

	/** Look up the remote tip without touching the local ref; undefined when the remote has no such ref. */
	async remoteHead(): Promise<string | undefined> {
		const stdout = await this.git(this.repo, [
			"ls-remote",
			"--refs",
			this.remote,
			this.ref,
		]);
		const line = stdout.split("\n").find((l) => l.endsWith(`\t${this.ref}`));
		this.remoteTip = line?.split("\t")[0];
		return this.remoteTip;
	}

	/** Push `tip` soon; resolves when it (or a newer scheduled tip) is pushed. */
	async schedule(tip: string): Promise<void> {
		if (this.failure) {
			throw this.failure;
		}
		this.wanted = tip;
		this.running ??= this.drain().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Push `tip` now (after any push in flight); throws why pushing stopped, if it did. */
	async flush(tip: string | undefined): Promise<void> {
		if (this.running !== undefined) {
			await this.running.catch(() => undefined);
		}
		if (this.failure) {
			throw this.failure;
		}
		if (tip !== undefined && tip !== this.remoteTip) {
			await this.schedule(tip);
		}
	}

	private async drain(): Promise<void> {
		let failures = 0;
		while (this.wanted !== undefined && this.wanted !== this.remoteTip) {
			const tip = this.wanted;
			// oxlint-disable-next-line eslint/no-await-in-loop -- pushes go one at a time, newest tip next
			const detail = await this.push(tip);
			if (detail === undefined) {
				failures = 0;
				this.remoteTip = tip;
				this.log(`${this.ref}: pushed ${tip.slice(0, 7)}`);
			} else if (CONFLICT_PATTERN.test(detail)) {
				// The remote has history this one lacks: every later push would be refused the same way.
				this.failure = new GitSyncConflictError(this.ref, detail);
				throw this.failure;
			} else {
				const delay = this.retryDelaysMs[failures];
				failures += 1;
				if (delay === undefined) {
					throw new Error(
						`Push of ${this.ref} failed (${failures} attempts): ${detail}`,
					);
				}
				this.log(
					`${this.ref}: push of ${tip.slice(0, 7)} failed, retrying in ${delay} ms: ${detail}`,
				);
				// oxlint-disable-next-line eslint/no-await-in-loop -- a retry waits for the backoff
				await sleep(delay);
			}
		}
	}

	/** Push `tip` to the ref; resolves with why it failed (git's stderr), undefined when it was pushed. */
	private async push(tip: string): Promise<string | undefined> {
		try {
			await this.git(this.repo, [
				"push",
				"--quiet",
				"--no-verify",
				this.remote,
				`${tip}:${this.ref}`,
			]);
			return undefined;
		} catch (error) {
			return (error instanceof GitError && error.stderr) || String(error);
		}
	}
}
