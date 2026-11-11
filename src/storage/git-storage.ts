// A pi-durable Storage that keeps its log as a chain of git commits on one ref.
//
// Like the JSONL backend, the state lives in a MemoryStorage; every stored batch is one git commit whose tree holds
// `batch.json` ({ format, seq, writes }), parented on the previous batch. Opening replays the chain from its root.
// The ref moves by compare-and-swap, so a second writer on the same ref fails instead of forking the log.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type EntryId,
	type Id,
	MemoryStorage,
	type Seq,
	type Storage,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { GitRepo, type Signature } from "./git.js";

const FORMAT_VERSION = 1;
const BATCH_FILE = "batch.json";
const DEFAULT_AUTHOR: Signature = {
	name: "pi-durable",
	email: "pi-durable@localhost",
};

export interface GitStorageOptions {
	/** A work tree, `.git` dir, or bare repository. It must exist. */
	readonly repo: string;
	/** The ref holding the log, e.g. `refs/pi/threads/42`. */
	readonly ref: string;
	/** Commit author and committer. */
	readonly author?: Signature;
	/** Append to `logs/<ref>`, as git does for branches. Default false (git doesn't log custom refs either). */
	readonly reflog?: boolean;
	/** Open without writing; `commit()` rejects. */
	readonly readOnly?: boolean;
	/**
	 * Called after each stored commit() with the new tip and the batches it added, e.g. to push at turn boundaries
	 * (see `isTurnBoundary`). Must not throw; errors are swallowed.
	 */
	readonly onCommit?: (event: CommitEvent) => void;
}

interface CommitEvent {
	readonly tip: string;
	readonly batches: readonly Batch[];
}

export interface Batch {
	readonly format: number;
	readonly seq: number;
	readonly writes: readonly StorageWrite[];
}

class GitStorageCorruptionError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "GitStorageCorruptionError";
	}
}
class GitStorageReadOnlyError extends Error {
	constructor() {
		super("Git storage is open read-only");
		this.name = "GitStorageReadOnlyError";
	}
}
export class GitStoragePoisonedError extends Error {
	constructor(cause: unknown) {
		super("Git storage is poisoned and must be reopened", { cause });
		this.name = "GitStoragePoisonedError";
	}
}

export class GitStorage implements Storage {
	readonly repo: GitRepo;
	readonly ref: string;
	private readonly author: Signature;
	private readonly reflog: boolean;
	private readonly readOnly: boolean;
	private readonly onCommit: GitStorageOptions["onCommit"];
	private readonly memory = new MemoryStorage();
	private head: string | undefined;
	private closed = false;
	private poisonError: GitStoragePoisonedError | undefined;
	/** Settles once the batches being written are; memory is ahead of the ref meanwhile. */
	private writing: Promise<void> | undefined;
	/** Serializes commit() calls. */
	private queue: Promise<void> = Promise.resolve();

	private constructor(repo: GitRepo, options: GitStorageOptions) {
		this.repo = repo;
		this.ref = options.ref;
		this.author = options.author ?? DEFAULT_AUTHOR;
		this.reflog = options.reflog ?? false;
		this.readOnly = options.readOnly ?? false;
		this.onCommit = options.onCommit;
	}

	static async open(options: GitStorageOptions): Promise<GitStorage> {
		const repo = await GitRepo.open(options.repo);
		const storage = new GitStorage(repo, options);
		try {
			await storage.recover();
		} catch (error) {
			await repo.close();
			throw error;
		}
		return storage;
	}

	/** The commit the ref points at, as of the last commit or open; undefined while empty. */
	get tip(): string | undefined {
		return this.head;
	}

	private async recover(): Promise<void> {
		const tip = await this.repo.readRef(this.ref);
		this.head = tip;
		if (tip === undefined) {
			return;
		}
		const chain = await this.repo.commits(tip);
		const merge = chain.find((commit) => commit.parents.length > 1);
		if (merge) {
			throw new GitStorageCorruptionError(
				`Merge commit ${merge.id} in ${this.ref}`,
			);
		}
		// All reads go to one cat-file process, which pipelines them.
		const batches = await Promise.all(
			chain.map(async ({ id: sha }) => {
				const content = await this.repo
					.readFile(sha, BATCH_FILE)
					.catch((error: unknown) => {
						throw new GitStorageCorruptionError(
							`Commit ${sha} has no ${BATCH_FILE}`,
							{ cause: error },
						);
					});
				let batch: Batch;
				try {
					batch = JSON.parse(content.toString("utf8"));
				} catch (error) {
					throw new GitStorageCorruptionError(
						`Malformed ${BATCH_FILE} in ${sha}`,
						{ cause: error },
					);
				}
				if (
					batch?.format !== FORMAT_VERSION ||
					!Number.isSafeInteger(batch.seq) ||
					!Array.isArray(batch.writes)
				) {
					throw new GitStorageCorruptionError(
						`Unsupported or invalid batch in ${sha}`,
					);
				}
				return { sha, batch };
			}),
		);
		for (const { sha, batch } of batches) {
			try {
				this.memory.prepareCommit(batch.writes, batch.seq as Seq).apply();
			} catch (error) {
				throw new GitStorageCorruptionError(
					`Invalid committed state at seq ${batch.seq} (${sha})`,
					{ cause: error },
				);
			}
		}
	}

	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): ReturnType<Storage["commit"]> {
		this.assertUsable();
		if (this.readOnly) {
			throw new GitStorageReadOnlyError();
		}
		const previous = this.queue;
		const turn = Promise.withResolvers<void>();
		this.queue = turn.promise;
		await previous;
		const writing = Promise.withResolvers<void>();
		this.writing = writing.promise;
		const seqs: Seq[] = [];
		const encoded: Batch[] = [];
		let refused: { error: unknown } | undefined;
		try {
			this.assertUsable();
			for (const writes of batches) {
				let prepared: ReturnType<MemoryStorage["prepareCommit"]>;
				try {
					prepared = this.memory.prepareCommit(writes);
				} catch (error) {
					refused = { error };
					break;
				}
				encoded.push({
					format: FORMAT_VERSION,
					seq: prepared.seq,
					writes: prepared.writes,
				});
				seqs.push(prepared.apply());
			}
			if (encoded.length > 0) {
				await this.persist(encoded, context);
			}
		} catch (error) {
			// Memory ran ahead of the ref: once a batch applied, any failure poisons the storage.
			if (seqs.length === 0) {
				throw error;
			}
			throw this.poison(error);
		} finally {
			this.writing = undefined;
			writing.resolve();
			turn.resolve();
		}
		for (const [index, seq] of seqs.entries()) {
			receive(index, seq);
		}
		if (
			encoded.length > 0 &&
			this.head !== undefined &&
			this.onCommit !== undefined
		) {
			try {
				this.onCommit({ tip: this.head, batches: encoded });
			} catch {
				// observers never fail a commit
			}
		}
		return refused === undefined
			? { stored: seqs.length }
			: { stored: seqs.length, refused: refused.error };
	}

	private async persist(
		batches: readonly Batch[],
		_context: Context,
	): Promise<void> {
		let parent = this.head;
		for (const batch of batches) {
			// biome-ignore lint/performance/noAwaitInLoops: each commit is the parent of the next
			const blob = await this.repo.writeBlob(JSON.stringify(batch));
			const tree = await this.repo.writeTree({ [BATCH_FILE]: blob });
			parent = await this.repo.writeCommit({
				tree,
				parents: parent === undefined ? [] : [parent],
				author: this.author,
				message: commitMessage(batch),
			});
		}
		if (parent === undefined) {
			return;
		}
		await this.repo.updateRef(
			this.ref,
			parent,
			this.head,
			this.reflog ? `pi-durable: seq ${batches.at(-1)?.seq}` : undefined,
		);
		this.head = parent;
	}

	mintId<I extends Id<string>>(): Promise<I> {
		try {
			return this.store.mintId<I>();
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async conversation(...args: Parameters<Storage["conversation"]>) {
		return (await this.readable()).conversation(...args);
	}
	async scanConversations(...args: Parameters<Storage["scanConversations"]>) {
		return (await this.readable()).scanConversations(...args);
	}
	entry(id: EntryId, context: Context): ReturnType<MemoryStorage["entry"]>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): ReturnType<MemoryStorage["entry"]>;
	async entry(
		idOrConversation: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): ReturnType<MemoryStorage["entry"]> {
		const memory = await this.readable();
		return context === undefined
			? memory.entry(idOrConversation as EntryId, idOrContext as Context)
			: memory.entry(
					idOrConversation as ConversationId,
					idOrContext as EntryId,
					context,
				);
	}
	async findLatestHeadMarker(
		...args: Parameters<Storage["findLatestHeadMarker"]>
	) {
		return (await this.readable()).findLatestHeadMarker(...args);
	}
	async scanEntries(...args: Parameters<Storage["scanEntries"]>) {
		return (await this.readable()).scanEntries(...args);
	}
	async task(...args: Parameters<Storage["task"]>) {
		return (await this.readable()).task(...args);
	}
	async scanTasks(...args: Parameters<Storage["scanTasks"]>) {
		return (await this.readable()).scanTasks(...args);
	}
	async submission(...args: Parameters<Storage["submission"]>) {
		return (await this.readable()).submission(...args);
	}
	async scanSubmissions(...args: Parameters<Storage["scanSubmissions"]>) {
		return (await this.readable()).scanSubmissions(...args);
	}
	async submissionByRequest(
		...args: Parameters<Storage["submissionByRequest"]>
	) {
		return (await this.readable()).submissionByRequest(...args);
	}
	async findDocument(...args: Parameters<Storage["findDocument"]>) {
		return (await this.readable()).findDocument(...args);
	}
	async document(...args: Parameters<Storage["document"]>) {
		return (await this.readable()).document(...args);
	}
	async scanDocuments(...args: Parameters<Storage["scanDocuments"]>) {
		return (await this.readable()).scanDocuments(...args);
	}

	async close(context: Context): Promise<void> {
		// biome-ignore lint/suspicious/noUnnecessaryConditions: close() may be called twice
		if (this.closed) {
			return;
		}
		this.closed = true;
		await this.queue;
		await this.memory.close(context);
		await this.repo.close();
	}

	private get store(): MemoryStorage {
		this.assertUsable();
		return this.memory;
	}
	private async readable(): Promise<MemoryStorage> {
		while (this.writing !== undefined) {
			// biome-ignore lint/performance/noAwaitInLoops: a new write may start while we wait
			await this.writing;
		}
		return this.store;
	}
	private poison(cause: unknown): GitStoragePoisonedError {
		this.poisonError ??= new GitStoragePoisonedError(cause);
		return this.poisonError;
	}
	private assertUsable(): void {
		// biome-ignore lint/suspicious/noUnnecessaryConditions: set by close()
		if (this.closed) {
			throw new Error("GitStorage is closed");
		}
		if (this.poisonError !== undefined) {
			throw this.poisonError;
		}
	}
}

/** `pi-durable: seq 12 (entry, task×2)` plus trailers, so `git log` reads well. */
function commitMessage(batch: Batch): string {
	const counts = new Map<string, number>();
	for (const write of batch.writes) {
		counts.set(write.type, (counts.get(write.type) ?? 0) + 1);
	}
	const summary = [...counts]
		.map(([type, n]) => (n === 1 ? type : `${type}×${n}`))
		.join(", ");
	return `pi-durable: seq ${batch.seq} (${summary})\n\nPi-Durable-Format: ${batch.format}\nPi-Durable-Seq: ${batch.seq}\n`;
}
