// Working-tree continuity: a thread's conversation and the files pi left uncommitted move together.
//
// Each snapshot (src/storage/worktree.ts) is recorded on refs/pi/worktrees/<n>, and the conversation points at it
// with the `pi-action.worktree` document (rewindable, fork "asOf"), written in the same commit as a marker entry. A
// fork or rewind of the conversation thus sees the snapshot as of its fork entry. At the start of a run, the
// snapshot the conversation points at is restored, unless that would drop work that only the newest snapshot has:
// then pi-action asks first.
import { createHash } from "node:crypto";

import {
	BACKGROUND_CONTEXT,
	type Context,
} from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	type Harness,
} from "@earendil-works/pi-durable";

import {
	captureState,
	isClean,
	latestSnapshot,
	readSnapshot,
	recordSnapshot,
	type RestoreOutcome,
	restoreSnapshot,
	type SnapshotLimits,
	type SnapshotRecord,
	stateKey,
	uniqueWork,
	type UniqueWork,
	writeStash,
} from "./storage/worktree.ts";
import type { Log, UiAnswer, UiQuestion } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

const context: Context = BACKGROUND_CONTEXT;

/** The marker entry written with each change of the document; never shown to the model. */
export const WORKTREE_ENTRY_KIND = "pi-action.worktree";
/** The entry that tells the model how the restore went. */
export const RESTORE_ENTRY_KIND = "pi-action.worktree-restore";
const LISTED = 20;

/** The snapshot a conversation points at: its stash commit W and its wrapper commit on the ref. Empty: none. */
export const WorktreeDoc = defineDoc<{ stash: string; wrapper: string }>({
	kind: "pi-action.worktree",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ stash: "", wrapper: "" }),
	checkpointWhen: () => true,
});

export const REWIND_OPTION = "Rewind files too";
export const KEEP_OPTION =
	"Keep the latest files, rewind only the conversation";
export const CANCEL_OPTION = "Cancel";

export interface WorktreeOptions {
	readonly cwd: string;
	/** `refs/pi/worktrees/<n>`. */
	readonly ref: string;
	readonly limits: SnapshotLimits;
	readonly log: Log;
	readonly remote?: string | undefined;
}

/** How the run may go on after `restore()`. */
export type RestoreResult =
	| { readonly kind: "ready"; readonly message: string | undefined }
	| { readonly kind: "asked"; readonly url: string | undefined }
	| { readonly kind: "cancelled" };

export interface RestoreInput {
	/** Posts the guard's question; undefined when nobody can answer (no questions, a fork PR). */
	readonly ask?:
		| ((question: UiQuestion) => Promise<{ url?: string }>)
		| undefined;
	/** The answer that started this run, if any; consumed when it answers the guard's question. */
	readonly answer?: UiAnswer | undefined;
	/** The thread's current tip, for the trailers of a snapshot recorded while restoring. */
	readonly threadTip?: string | undefined;
}

const short = (sha: string): string => sha.slice(0, 7);

/** A bulleted list of at most LISTED items. */
function list(items: readonly string[]): string {
	const shown = items.slice(0, LISTED).map((item) => `- ${item}`);
	if (items.length > LISTED) {
		shown.push(`- ...and ${items.length - LISTED} more`);
	}
	return shown.join("\n");
}

function skippedNote(record: SnapshotRecord): string {
	return record.skipped.length === 0
		? ""
		: `\n\nThese untracked files were not saved in the snapshot, so they are missing:\n${list(record.skipped.map((skip) => `\`${skip.path}\` (${skip.reason})`))}`;
}

const applyHint = (record: SnapshotRecord): string =>
	`The snapshot is saved at ${record.stash}: \`git stash show -p --include-untracked ${short(record.stash)}\` shows it, \`git stash apply --index ${short(record.stash)}\` applies it.`;

/** The message that tells the model how the restore went. */
export function restoreMessage(
	outcome: RestoreOutcome,
	record: SnapshotRecord,
): string {
	const intro = `[pi-action] This run started from a fresh checkout. pi-action restored the files the earlier run left uncommitted (working-tree snapshot ${short(record.stash)})`;
	if (outcome.status === "diverged") {
		return `[pi-action] This run started from a fresh checkout. pi-action did not restore the files the earlier run left uncommitted: branch \`${outcome.branch}\` on the remote (${short(outcome.remoteHead)}) diverged from the commit the earlier run worked on (${short(outcome.head)}). ${applyHint(record)}`;
	}
	if (outcome.status === "failed") {
		return `[pi-action] Restoring the files the earlier run left uncommitted failed (${outcome.error}), so this run started from a clean checkout. ${applyHint(record)}`;
	}
	const where = `HEAD is ${outcome.branch === undefined ? "detached" : `on branch \`${outcome.branch}\``} at ${short(outcome.head)}`;
	const moved = outcome.moved
		? " The branch had moved on the remote since then, so the changes were merged onto it."
		: "";
	const staging = outcome.staged
		? " Staged and unstaged changes are as they were."
		: " The staging area could not be restored: all changes are unstaged now.";
	const conflicts =
		outcome.conflicts.length > 0
			? `\n\nThese files have conflict markers; resolve them before you go on:\n${list(outcome.conflicts.map((path) => `\`${path}\``))}`
			: "";
	return `${intro}. ${where}.${moved}${staging}${conflicts}${skippedNote(record)}`;
}

/** The guard's question key: one per pair of snapshots. */
function questionKey(
	target: SnapshotRecord | undefined,
	latest: SnapshotRecord,
): string {
	return createHash("sha256")
		.update(`pi-action.worktree ${target?.wrapper ?? "-"} ${latest.wrapper}`)
		.digest("hex")
		.slice(0, 32);
}

function guardQuestion(
	key: string,
	latest: SnapshotRecord,
	work: UniqueWork,
): UiQuestion {
	const files = work.files.map((path) => `\`${path}\``).join(", ");
	const commits = work.commits.map(short).join(", ");
	const lost = [
		...(work.files.length > 0 ? [`files ${files}`] : []),
		...(work.commits.length > 0 ? [`unpushed commits ${commits}`] : []),
	].join(" and ");
	return {
		kind: "select",
		key,
		title: `The conversation was rewound. Rewind the files too? That drops ${lost} from the working tree; they stay saved in snapshot ${short(latest.stash)} (${latest.wrapper})`,
		options: [REWIND_OPTION, KEEP_OPTION, CANCEL_OPTION],
	};
}

/** Saves a thread's working tree at turn boundaries and restores it at the start of a run. */
export class WorktreeContinuity {
	private readonly options: WorktreeOptions;
	private conversation: { harness: Harness; root: Conversation } | undefined;
	/** The state last saved (or restored); a checkpoint of the same state saves nothing. */
	private lastKey: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	/** Whether the answer given to restore() answered its question. */
	answered = false;

	constructor(options: WorktreeOptions) {
		this.options = options;
	}

	get ref(): string {
		return this.options.ref;
	}

	/** Attach the conversation whose document points at the snapshots. */
	attach(harness: Harness, root: Conversation): void {
		this.conversation = { harness, root };
	}

	private attached(): { harness: Harness; root: Conversation } {
		if (this.conversation === undefined) {
			throw new Error("WorktreeContinuity is not attached to a conversation");
		}
		return this.conversation;
	}

	/** The snapshot the conversation points at as of its head; undefined when none. */
	async target(): Promise<SnapshotRecord | undefined> {
		const { harness, root } = this.attached();
		const doc = await harness.snapshot(WorktreeDoc, root.id, context);
		if (doc === undefined || doc.wrapper === "") {
			return undefined;
		}
		return readSnapshot(this.options.cwd, doc.wrapper);
	}

	/** Point the conversation at `record`: the document and a marker entry, in one commit. */
	private async point(record: SnapshotRecord): Promise<void> {
		const { root } = this.attached();
		await root.commit(async (tx) => {
			const doc = await tx.doc(WorktreeDoc, root.id);
			doc.stash = record.stash;
			doc.wrapper = record.wrapper;
			await tx.appendEntry(root.id, {
				kind: WORKTREE_ENTRY_KIND,
				data: { stash: record.stash, wrapper: record.wrapper },
			});
		}, context);
	}

	private async latestEntry(): Promise<string | undefined> {
		const { root } = this.attached();
		const id = await root.commit(
			async (tx) => tx.latestEntryId(root.id),
			context,
		);
		return id === undefined ? undefined : String(id);
	}

	/**
	 * Save the working tree if it changed since the last save (or restore): a new snapshot on the ref, and the
	 * conversation pointed at it. Resolves with the new wrapper, undefined when nothing changed. Calls run one at a
	 * time. A failure is logged, never thrown.
	 */
	async checkpoint(threadTip: string | undefined): Promise<string | undefined> {
		if (this.conversation === undefined) {
			return undefined;
		}
		const next = this.queue.then(async () => this.save(threadTip));
		this.queue = next.catch(() => undefined);
		try {
			return await next;
		} catch (error) {
			this.options.log.warning(
				`Could not save the working tree: ${getErrorMessage(error)}`,
			);
			return undefined;
		}
	}

	private async save(
		threadTip: string | undefined,
	): Promise<string | undefined> {
		const { cwd, ref, limits } = this.options;
		const state = await captureState(cwd, limits);
		const key = stateKey(state);
		if (key === this.lastKey) {
			return undefined;
		}
		if (this.lastKey === undefined && isClean(state)) {
			// Nothing to keep yet, and nothing was ever restored.
			this.lastKey = key;
			return undefined;
		}
		const stash = await writeStash(cwd, state);
		const record = await recordSnapshot(cwd, ref, {
			...state,
			stash,
			threadTip,
			threadEntry: await this.latestEntry(),
		});
		await this.point(record);
		this.lastKey = key;
		this.options.log.info(
			`Saved the working tree as ${short(stash)} on ${ref}${state.skipped.length > 0 ? ` (skipped ${state.skipped.length} untracked file(s))` : ""}`,
		);
		return record.wrapper;
	}

	/** What restore() chooses: the target, the latest snapshot, a question, or a cancellation. */
	private async choose(
		target: SnapshotRecord | undefined,
		latest: SnapshotRecord | undefined,
		input: RestoreInput,
	): Promise<
		| { kind: "record"; record: SnapshotRecord | undefined; note: string }
		| { kind: "asked"; url: string | undefined }
		| { kind: "cancelled" }
	> {
		const { cwd, log, remote } = this.options;
		if (latest === undefined || latest.stash === target?.stash) {
			return { kind: "record", record: target, note: "" };
		}
		const work = await uniqueWork(cwd, latest, target, remote);
		if (work.files.length === 0 && work.commits.length === 0) {
			return { kind: "record", record: target, note: "" };
		}
		const key = questionKey(target, latest);
		if (input.answer?.key === key) {
			this.answered = true;
			log.info(
				`@${input.answer.by} answered the working-tree question: ${String(input.answer.answer)}`,
			);
			if (input.answer.answer === CANCEL_OPTION) {
				return { kind: "cancelled" };
			}
			return input.answer.answer === KEEP_OPTION
				? { kind: "record", record: latest, note: "" }
				: { kind: "record", record: target, note: "" };
		}
		if (input.ask === undefined) {
			const lost = [
				...work.files.map((path) => `\`${path}\``),
				...work.commits.map((sha) => `commit ${short(sha)}`),
			];
			log.warning(
				`The conversation points at an older working-tree snapshot than ${short(latest.stash)}, which has work that exists nowhere else, and nobody can be asked: the files were not rewound`,
			);
			return {
				kind: "record",
				record: latest,
				note: `\n\nThe conversation was rewound to an earlier point, but the files were not: the newest snapshot (${short(latest.stash)}) has work that exists nowhere else, and nobody could be asked whether to drop it (questions are not available in this run). The files are those of the newest snapshot. Work only that snapshot has:\n${list(lost)}`,
			};
		}
		const asked = await input.ask(guardQuestion(key, latest, work));
		log.info(
			`Asked whether to rewind the files too${asked.url ? ` (${asked.url})` : ""}; the run ends until someone answers`,
		);
		return { kind: "asked", url: asked.url };
	}

	/**
	 * Restore the snapshot the conversation points at into the checkout, before any work runs. Returns the message
	 * for the model (undefined when there was nothing to restore), or that the run must end: a question was asked,
	 * or its answer was Cancel. A failed restore starts clean and says so; it never throws.
	 */
	async restore(input: RestoreInput = {}): Promise<RestoreResult> {
		const { cwd, ref, limits, log, remote } = this.options;
		try {
			const [target, latest] = await Promise.all([
				this.target(),
				latestSnapshot(cwd, ref),
			]);
			const choice = await this.choose(target, latest, input);
			if (choice.kind !== "record") {
				return choice;
			}
			const { record, note } = choice;
			const before = await captureState(cwd, limits);
			if (record === undefined) {
				this.lastKey = stateKey(before);
				return { kind: "ready", message: undefined };
			}
			if (
				before.indexTree !== before.headTree ||
				before.worktreeTree !== before.headTree
			) {
				log.warning(
					`The checkout has uncommitted changes; not restoring ${short(record.stash)}`,
				);
				this.lastKey = stateKey(before);
				return {
					kind: "ready",
					message: `[pi-action] The checkout already had uncommitted changes when this run started, so pi-action did not restore the files the earlier run left uncommitted. ${applyHint(record)}`,
				};
			}
			const outcome = await restoreSnapshot(cwd, record, remote);
			log.info(
				`Restored working-tree snapshot ${short(record.stash)}: ${outcome.status}`,
			);
			if (outcome.status === "restored" && latest !== undefined) {
				await this.keepChosen(record, target, latest, input.threadTip);
			}
			this.lastKey = stateKey(await captureState(cwd, limits));
			return {
				kind: "ready",
				message: `${restoreMessage(outcome, record)}${note}`,
			};
		} catch (error) {
			log.warning(
				`Could not restore the working tree: ${getErrorMessage(error)}`,
			);
			return {
				kind: "ready",
				message: `[pi-action] Restoring the files the earlier run left uncommitted failed (${getErrorMessage(error)}), so this run started from a clean checkout.`,
			};
		}
	}

	/**
	 * After restoring an older snapshot, record it again on top of the ref, so the newest snapshot is what the
	 * files are now (the newer one stays reachable below it); and point the conversation at what was restored.
	 */
	private async keepChosen(
		record: SnapshotRecord,
		target: SnapshotRecord | undefined,
		latest: SnapshotRecord,
		threadTip: string | undefined,
	): Promise<void> {
		let pointed = record;
		if (record.wrapper !== latest.wrapper) {
			pointed = await recordSnapshot(this.options.cwd, this.options.ref, {
				...record,
				threadTip,
				threadEntry: await this.latestEntry(),
			});
		}
		if (pointed.wrapper !== target?.wrapper) {
			await this.point(pointed);
		}
	}
}
