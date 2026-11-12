import {
	BACKGROUND_CONTEXT,
	type Context,
} from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type CommitResult,
	type Conversation,
	createRegistry,
	type EntryId,
	type EntryRecord,
	type Extension,
	Harness,
	MemoryStorage,
	type Storage,
	type StorageWrite,
	type Submission,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { GitStorage } from "./storage/git-storage.ts";
import { git } from "./storage/git.ts";
import { GitSync, isTurnBoundary, liveRef } from "./storage/sync.ts";
import { type SnapshotLimits, worktreeRef } from "./storage/worktree.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";
import { RESTORE_ENTRY_KIND, WorktreeContinuity } from "./worktree.ts";

const context: Context = BACKGROUND_CONTEXT;

const POSTED_KIND = "pi-action.posted";
const COMMENT_KIND = "pi-action.comment";
const KEY_FIELD = "key";
const URL_FIELD = "url";

export const threadRef = (issueNumber: number): string =>
	`refs/pi/threads/${issueNumber}`;

export interface ThreadOptions {
	cwd: string;
	/** The issue or PR; undefined for a one-off prompt, which is kept in memory only. */
	issueNumber?: number | undefined;
	models: Models;
	model: Model<Api>;
	log: Log;
	remote?: string | undefined;
	/** pi-durable extensions from the `extensions` input, installed after the coding tools. */
	extensions?: readonly Extension[];
	/** Variables the tools' shell gets on top of the process environment (see `toolEnv()`). */
	toolEnv?: Readonly<Record<string, string>> | undefined;
	/** Save and restore the working tree with the thread (stored threads only), with these limits; undefined: don't. */
	worktree?: SnapshotLimits | undefined;
	/** Called with the entries of each stored commit, in order (see activity.ts); must not throw. */
	onEntries?: ((entries: readonly EntryRecord[]) => void) | undefined;
}

/** The entries among `writes`. */
function entriesOf(writes: readonly StorageWrite[]): EntryRecord[] {
	return writes.flatMap((write) =>
		write.type === "entry" ? [write.value] : [],
	);
}

/** A one-off conversation's storage, which reports the entries it stores as GitStorage's `onCommit` does. */
class ObservedMemoryStorage extends MemoryStorage {
	private readonly onEntries: (entries: readonly EntryRecord[]) => void;

	constructor(onEntries: (entries: readonly EntryRecord[]) => void) {
		super();
		this.onEntries = onEntries;
	}

	override async commit(
		...args: Parameters<MemoryStorage["commit"]>
	): Promise<CommitResult> {
		const result = await super.commit(...args);
		this.onEntries(
			args[0].slice(0, result.stored).flatMap((writes) => entriesOf(writes)),
		);
		return result;
	}
}

/** What `Thread.answerText()` reports about a run's answer. */
export interface RunAnswer {
	text: string;
	toolCalls: boolean;
	/** The assistant message's stop reason; `length` when it hit the output token limit (max_tokens). */
	stopReason: string | undefined;
	/** Whether the run executed tools before this answer. */
	usedTools: boolean;
}

export interface ThreadInput {
	/** Stable per GitHub item, e.g. `comment-123`: resubmitting it returns the same submission. */
	key: string;
	content: string;
	data: Record<string, string>;
	/** Place the input as this entry instead of a comment (an answer to a question: `ui.answer`). */
	entry?: { kind: string; data: Record<string, string | boolean> } | undefined;
}

interface Persistence {
	ref: string;
	storage: GitStorage;
	saver: ThreadSaver;
	worktree: WorktreeContinuity | undefined;
	startedAt: Date | undefined;
	isNew: boolean;
}

/** The local tip of `ref`, undefined when it doesn't exist. */
async function localTip(cwd: string, ref: string): Promise<string | undefined> {
	const out = await git(cwd, ["rev-parse", "-q", "--verify", ref]).catch(
		() => "",
	);
	return out.trim() || undefined;
}

/** Pushes the thread, and the working-tree snapshots with it. */
class ThreadSaver {
	private readonly cwd: string;
	private readonly sync: GitSync;
	private readonly worktree: WorktreeContinuity | undefined;
	/** Set once the storage is open. */
	storage: GitStorage | undefined;

	constructor(
		cwd: string,
		sync: GitSync,
		worktree: WorktreeContinuity | undefined,
	) {
		this.cwd = cwd;
		this.sync = sync;
		this.worktree = worktree;
	}

	/** Push now (`flush`) or soon (`schedule`), saving the working tree first when `save`. */
	async push(how: "schedule" | "flush", save: boolean): Promise<void> {
		const tip = () => this.storage?.tip;
		if (this.worktree !== undefined && save) {
			await this.worktree.checkpoint();
		}
		const companion =
			this.worktree === undefined
				? undefined
				: await localTip(this.cwd, this.worktree.ref);
		const current = tip();
		if (how === "flush") {
			await this.sync.flush(current, companion);
		} else if (current !== undefined) {
			await this.sync.schedule(current, companion);
		}
	}
}

async function openPersistence(
	options: ThreadOptions,
	issueNumber: number,
): Promise<Persistence> {
	const { cwd, log } = options;
	const ref = threadRef(issueNumber);
	// The run works on local refs outside refs/pi/, where a fetch the agent runs can't move them (#46).
	const local = liveRef(ref);
	const worktree =
		options.worktree === undefined
			? undefined
			: new WorktreeContinuity({
					cwd,
					ref: liveRef(worktreeRef(issueNumber)),
					name: worktreeRef(issueNumber),
					limits: options.worktree,
					log,
					remote: options.remote,
				});
	const sync = new GitSync({
		repo: cwd,
		ref,
		localRef: local,
		companionRef: worktree === undefined ? undefined : worktreeRef(issueNumber),
		localCompanionRef: worktree?.ref,
		log: log.debug ?? log.info,
		remote: options.remote,
	});
	const remoteTip = await sync.fetch();
	const saver = new ThreadSaver(cwd, sync, worktree);
	const storage = await GitStorage.open({
		repo: cwd,
		ref: local,
		author: {
			name: "pi-action",
			email: "pi-action@users.noreply.github.com",
		},
		onCommit: ({ batches }) => {
			options.onEntries?.(batches.flatMap((batch) => entriesOf(batch.writes)));
			if (isTurnBoundary(batches)) {
				saver.push("schedule", true).catch((error: unknown) => {
					log.warning(getErrorMessage(error));
				});
			}
		},
	});
	saver.storage = storage;
	return {
		ref,
		storage,
		saver,
		worktree,
		isNew: remoteTip === undefined,
		startedAt: remoteTip ? await rootCommitTime(cwd, local) : undefined,
	};
}

/**
 * One GitHub issue or PR as a durable pi conversation, stored in git on refs/pi/threads/<n> and pushed to the
 * remote at every turn boundary. Without an issue number, the conversation lives in memory for this run only.
 */
export class Thread {
	private closed = false;
	private readonly harness: Harness;
	private readonly root: Conversation;
	private readonly persistence: Persistence | undefined;

	private constructor(
		harness: Harness,
		root: Conversation,
		persistence: Persistence | undefined,
	) {
		this.harness = harness;
		this.root = root;
		this.persistence = persistence;
	}

	static async open(options: ThreadOptions): Promise<Thread> {
		const { cwd } = options;
		const persistence =
			options.issueNumber === undefined
				? undefined
				: await openPersistence(options, options.issueNumber);
		const { onEntries } = options;
		const storage: Storage =
			persistence?.storage ??
			(onEntries === undefined
				? new MemoryStorage()
				: new ObservedMemoryStorage(onEntries));
		const registry = createRegistry();
		registry.install(CodingTools);
		for (const extension of options.extensions ?? []) {
			registry.install(extension);
		}
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				env: ({ cwd: dir }) =>
					new NodeExecutionEnv({
						cwd: dir ?? cwd,
						shellEnv: { ...options.toolEnv },
					}),
				settings: { retry: { maxRetries: 2 } },
			},
			context,
		);
		const agent = {
			model: { provider: options.model.provider, modelId: options.model.id },
			cwd,
		};
		const root = await harness.root(context, { agent });
		await root.configure(agent, context); // the model may differ from the last run's
		await restoreWorktree(persistence?.worktree, harness, root);
		harness.resume(); // finish whatever a previous, interrupted run left
		return new Thread(harness, root, persistence);
	}

	/** The commit the thread's ref points at, undefined before its first commit or when it is not stored. */
	get tip(): string | undefined {
		return this.persistence?.storage.tip;
	}

	/** The thread's ref, when it is stored in git. */
	get ref(): string | undefined {
		return this.persistence?.ref;
	}

	/** A thread nothing was stored for yet (always, in memory). */
	get isNew(): boolean {
		return this.persistence?.isNew ?? true;
	}

	/** When the thread's first commit was made; undefined for a new thread. */
	get startedAt(): Date | undefined {
		return this.persistence?.startedAt;
	}

	/** Comments arriving while a run works join it (steer); otherwise they start one. */
	async submit(input: ThreadInput): Promise<Submission> {
		return this.root.submit(
			{
				type: "input",
				content: input.content,
				requestId: input.key,
				whenBusy: "steer",
				entry: input.entry ?? {
					kind: COMMENT_KIND,
					data: { key: input.key, ...input.data },
				},
			},
			context,
		);
	}

	/**
	 * A run's answer: its text, whether it called tools (a run that ended on a `terminate` round), and why the
	 * model stopped (`length`: it ran out of output tokens); and whether the run executed any tool between its
	 * `input` entry and the answer.
	 */
	async answerText(answer: EntryId, input: EntryId): Promise<RunAnswer> {
		const entry = await this.root.commit(
			async (tx) => tx.entry(AssistantEntry, answer),
			context,
		);
		const message = entry?.model?.[0];
		const usedTools = await this.ranTools(input, answer);
		if (message?.role !== "assistant") {
			return { text: "", toolCalls: false, stopReason: undefined, usedTools };
		}
		return {
			text: message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("")
				.trim(),
			toolCalls: message.content.some((block) => block.type === "toolCall"),
			stopReason: message.stopReason,
			usedTools,
		};
	}

	/** Whether a tool result was written between two entries. */
	private async ranTools(from: EntryId, to: EntryId): Promise<boolean> {
		let cursor: Parameters<Conversation["entries"]>[2];
		do {
			// oxlint-disable-next-line eslint/no-await-in-loop -- pages follow each other
			const page = await this.root.entries(
				{ minEntryId: from, maxEntryId: to, order: "descending" },
				500,
				cursor,
				context,
			);
			if (page.items.some((item) => item.kind === ToolResultEntry.kind)) {
				return true;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return false;
	}

	/** Results already posted (`answer-<entryId>`, `error-<submissionId>`), with their comment URLs. */
	async postedResults(): Promise<Map<string, string>> {
		const posted = new Map<string, string>();
		let cursor: Parameters<Conversation["entries"]>[2];
		do {
			// oxlint-disable-next-line eslint/no-await-in-loop -- pages follow each other
			const page = await this.root.entries(
				{ order: "ascending" },
				500,
				cursor,
				context,
			);
			for (const { kind, data } of page.items) {
				if (kind === POSTED_KIND && typeof data === "object" && data !== null) {
					const key: unknown = Reflect.get(data, KEY_FIELD);
					const url: unknown = Reflect.get(data, URL_FIELD);
					if (typeof key === "string") {
						posted.set(key, typeof url === "string" ? url : "");
					}
				}
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return posted;
	}

	async markPosted(key: string, url: string): Promise<void> {
		await this.root.submit(
			{
				type: "write",
				entry: { kind: POSTED_KIND, data: { key, url } },
				requestId: `posted-${key}`,
			},
			context,
		);
	}

	async abort(): Promise<void> {
		await this.root.abort(context);
	}

	/** Push what is committed so far (with the working-tree snapshots); throws if the remote moved under us. */
	async push(): Promise<void> {
		await this.persistence?.saver.push("flush", false);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const worktree = this.persistence?.worktree;
		await worktree?.checkpoint();
		// Turn boundaries the closing harness still commits must not save into a closed conversation.
		worktree?.detach();
		await this.harness.close(context);
		await this.push();
	}
}

/**
 * Restore the working tree the conversation points at, before any work resumes, and tell the model how it went
 * (one entry with a user message).
 */
async function restoreWorktree(
	worktree: WorktreeContinuity | undefined,
	harness: Harness,
	root: Conversation,
): Promise<void> {
	if (worktree === undefined) {
		return;
	}
	worktree.attach(harness, root);
	const message = await worktree.restore();
	if (message !== undefined) {
		await root.submit(
			{
				type: "write",
				entry: {
					kind: RESTORE_ENTRY_KIND,
					data: { message },
					model: [{ role: "user", content: message, timestamp: Date.now() }],
				},
			},
			context,
		);
	}
}

/** When the thread's root commit was made. */
async function rootCommitTime(
	cwd: string,
	ref: string,
): Promise<Date | undefined> {
	const out = await git(cwd, [
		"log",
		"--max-parents=0",
		"--format=%cI",
		ref,
	]).catch(() => "");
	const [time] = out.trim().split("\n");
	return time ? new Date(time) : undefined;
}
