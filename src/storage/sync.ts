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
	/**
	 * A second ref that moves with `ref` (a thread's working-tree snapshots): fetched with it, and pushed with it in
	 * one `git push --atomic`, so the remote never has one without the other.
	 */
	readonly companionRef?: string | undefined;
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
	readonly companionRef: string | undefined;
	readonly remote: string;
	private readonly repo: string;
	private readonly log: (message: string) => void;
	/** What the remote ref is known to point at. */
	private remoteTip: string | undefined;
	private remoteCompanion: string | undefined;
	private wanted: string | undefined;
	private wantedCompanion: string | undefined;
	private running: Promise<void> | undefined;
	/** Why pushing stopped for good: another writer moved the remote ref. */
	private failure: GitSyncConflictError | undefined;
	private readonly retryDelaysMs: readonly number[];
	private readonly git: GitRunner;

	constructor(options: GitSyncOptions) {
		assertRefName(options.ref);
		if (options.companionRef !== undefined) {
			assertRefName(options.companionRef);
		}
		this.repo = options.repo;
		this.ref = options.ref;
		this.companionRef = options.companionRef;
		this.remote = options.remote ?? "origin";
		this.log = options.log ?? (() => undefined);
		this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
		this.git = options.git ?? git;
	}

	/**
	 * Make the local ref (and the companion ref) equal the remote one (creating, moving, or deleting it). Returns the
	 * remote tip of `ref`, undefined when the remote has no such ref yet.
	 */
	async fetch(): Promise<string | undefined> {
		const tips = await this.remoteHeads();
		const present: string[] = [];
		for (const [ref, tip] of [
			[this.ref, tips.tip],
			...(this.companionRef === undefined
				? []
				: [[this.companionRef, tips.companion] as const]),
		] as const) {
			if (tip === undefined) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- at most two refs
				await this.git(this.repo, ["update-ref", "-d", ref]).catch(
					() => undefined,
				);
				this.log(`${ref}: new on ${this.remote}`);
			} else {
				present.push(ref);
				this.log(`${ref}: fetched ${tip.slice(0, 7)}`);
			}
		}
		if (present.length > 0) {
			await this.git(this.repo, [
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				this.remote,
				...present.map((ref) => `+${ref}:${ref}`),
			]);
		}
		return tips.tip;
	}

	/** Look up the remote tip without touching the local ref; undefined when the remote has no such ref. */
	async remoteHead(): Promise<string | undefined> {
		return (await this.remoteHeads()).tip;
	}

	/** The remote tips of `ref` and of the companion ref, without touching the local refs. */
	async remoteHeads(): Promise<{
		tip: string | undefined;
		companion: string | undefined;
	}> {
		const refs = [this.ref, ...(this.companionRef ? [this.companionRef] : [])];
		const stdout = await this.git(this.repo, [
			"ls-remote",
			"--refs",
			this.remote,
			...refs,
		]);
		const lines = stdout.split("\n");
		const tipOf = (ref: string | undefined) =>
			ref === undefined
				? undefined
				: lines.find((l) => l.endsWith(`\t${ref}`))?.split("\t")[0];
		this.remoteTip = tipOf(this.ref);
		this.remoteCompanion = tipOf(this.companionRef);
		return { tip: this.remoteTip, companion: this.remoteCompanion };
	}

	/**
	 * Push `tip` (and `companion` to the companion ref) soon; resolves when it (or a newer scheduled tip) is pushed.
	 * An undefined `companion` keeps the one scheduled before.
	 */
	async schedule(tip: string, companion?: string): Promise<void> {
		if (this.failure) {
			throw this.failure;
		}
		this.wanted = tip;
		if (companion !== undefined && this.companionRef !== undefined) {
			this.wantedCompanion = companion;
		}
		this.running ??= this.drain().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Push `tip` (and `companion`) now, after any push in flight; throws why pushing stopped, if it did. */
	async flush(tip: string | undefined, companion?: string): Promise<void> {
		if (this.running !== undefined) {
			await this.running.catch(() => undefined);
		}
		if (this.failure) {
			throw this.failure;
		}
		if (
			tip !== undefined &&
			(tip !== this.remoteTip || this.companionPending(companion))
		) {
			await this.schedule(tip, companion);
		}
	}

	/** Whether the companion ref has (or would have, with `next`) a tip the remote lacks. */
	private companionPending(next?: string): boolean {
		const wanted = next ?? this.wantedCompanion;
		return (
			this.companionRef !== undefined &&
			wanted !== undefined &&
			wanted !== this.remoteCompanion
		);
	}

	private async drain(): Promise<void> {
		let failures = 0;
		while (
			this.wanted !== undefined &&
			(this.wanted !== this.remoteTip || this.companionPending())
		) {
			const tip = this.wanted;
			const companion = this.companionPending()
				? this.wantedCompanion
				: undefined;
			// oxlint-disable-next-line eslint/no-await-in-loop -- pushes go one at a time, newest tip next
			const detail = await this.push(tip, companion);
			if (detail === undefined) {
				failures = 0;
				this.remoteTip = tip;
				if (companion === undefined) {
					this.log(`${this.ref}: pushed ${tip.slice(0, 7)}`);
				} else {
					this.remoteCompanion = companion;
					this.log(
						`${this.ref}: pushed ${tip.slice(0, 7)} with ${this.companionRef ?? ""} at ${companion.slice(0, 7)}`,
					);
				}
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

	/**
	 * Push `tip` to the ref, and `companion` to the companion ref in the same atomic push; resolves with why it failed
	 * (git's stderr), undefined when it was pushed.
	 */
	private async push(
		tip: string,
		companion: string | undefined,
	): Promise<string | undefined> {
		const both = companion !== undefined && this.companionRef !== undefined;
		try {
			await this.git(this.repo, [
				"push",
				"--quiet",
				"--no-verify",
				...(both ? ["--atomic"] : []),
				this.remote,
				`${tip}:${this.ref}`,
				...(both ? [`${companion}:${this.companionRef}`] : []),
			]);
			return undefined;
		} catch (error) {
			return (error instanceof GitError && error.stderr) || String(error);
		}
	}
}
