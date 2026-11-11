import { MemoryStorage } from "@earendil-works/pi-durable";
import { GitRepo } from "./git.js";
export const FORMAT_VERSION = 1;
const BATCH_FILE = "batch.json";
const DEFAULT_AUTHOR = { name: "pi-durable", email: "pi-durable@localhost" };
export class GitStorageCorruptionError extends Error {
    constructor(message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "GitStorageCorruptionError";
    }
}
export class GitStorageReadOnlyError extends Error {
    constructor() {
        super("Git storage is open read-only");
        this.name = "GitStorageReadOnlyError";
    }
}
export class GitStoragePoisonedError extends Error {
    constructor(cause) {
        super("Git storage is poisoned and must be reopened", { cause });
        this.name = "GitStoragePoisonedError";
    }
}
export class GitStorage {
    repo;
    ref;
    author;
    reflog;
    readOnly;
    onCommit;
    memory = new MemoryStorage();
    head;
    closed = false;
    poisonError;
    /** Settles once the batches being written are; memory is ahead of the ref meanwhile. */
    writing;
    /** Serializes commit() calls. */
    queue = Promise.resolve();
    constructor(repo, options) {
        this.repo = repo;
        this.ref = options.ref;
        this.author = options.author ?? DEFAULT_AUTHOR;
        this.reflog = options.reflog ?? false;
        this.readOnly = options.readOnly ?? false;
        this.onCommit = options.onCommit;
    }
    static async open(options) {
        const repo = await GitRepo.open(options.repo, { fsync: options.fsync });
        const storage = new GitStorage(repo, options);
        try {
            await storage.recover();
        }
        catch (error) {
            await repo.close();
            throw error;
        }
        return storage;
    }
    /** The commit the ref points at, as of the last commit or open; undefined while empty. */
    get tip() {
        return this.head;
    }
    async recover() {
        const tip = await this.repo.readRef(this.ref);
        this.head = tip;
        if (tip === undefined)
            return;
        // First-parent chain, newest first; reading commits is inherently sequential.
        const chain = [];
        for (let sha = tip; sha !== undefined;) {
            const commit = await this.repo.readCommit(sha);
            if (commit.parents.length > 1)
                throw new GitStorageCorruptionError(`Merge commit ${sha} in ${this.ref}`);
            chain.push({ sha, tree: commit.tree });
            sha = commit.parents[0];
        }
        chain.reverse();
        // Trees and blobs can be fetched in parallel (cat-file pipelines them).
        const batches = await Promise.all(chain.map(async ({ sha, tree }) => {
            const entries = await this.repo.readTree(tree);
            const blob = entries[BATCH_FILE];
            if (blob === undefined)
                throw new GitStorageCorruptionError(`Commit ${sha} has no ${BATCH_FILE}`);
            const object = await this.repo.readObject(blob);
            let batch;
            try {
                batch = JSON.parse(object.content.toString("utf8"));
            }
            catch (error) {
                throw new GitStorageCorruptionError(`Malformed ${BATCH_FILE} in ${sha}`, error);
            }
            if (batch?.format !== FORMAT_VERSION || !Number.isSafeInteger(batch.seq) || !Array.isArray(batch.writes)) {
                throw new GitStorageCorruptionError(`Unsupported or invalid batch in ${sha}`);
            }
            return { sha, batch };
        }));
        for (const { sha, batch } of batches) {
            try {
                this.memory.prepareCommit(batch.writes, batch.seq).apply();
            }
            catch (error) {
                throw new GitStorageCorruptionError(`Invalid committed state at seq ${batch.seq} (${sha})`, error);
            }
        }
    }
    async commit(batches, receive, context) {
        this.assertUsable();
        if (this.readOnly)
            throw new GitStorageReadOnlyError();
        const previous = this.queue;
        let release;
        this.queue = new Promise((resolve) => (release = resolve));
        await previous;
        const writing = Promise.withResolvers();
        this.writing = writing.promise;
        const seqs = [];
        const encoded = [];
        let refused;
        try {
            this.assertUsable();
            for (const writes of batches) {
                let prepared;
                try {
                    prepared = this.memory.prepareCommit(writes);
                }
                catch (error) {
                    refused = { error };
                    break;
                }
                encoded.push({ format: FORMAT_VERSION, seq: prepared.seq, writes: prepared.writes });
                seqs.push(prepared.apply());
            }
            if (encoded.length > 0)
                await this.persist(encoded, context);
        }
        catch (error) {
            // Memory ran ahead of the ref: once a batch applied, any failure poisons the storage.
            if (seqs.length === 0)
                throw error;
            throw this.poison(error);
        }
        finally {
            this.writing = undefined;
            writing.resolve();
            release();
        }
        for (const [index, seq] of seqs.entries())
            receive(index, seq);
        if (encoded.length > 0 && this.head !== undefined && this.onCommit !== undefined) {
            try {
                this.onCommit({ tip: this.head, batches: encoded });
            }
            catch {
                // observers never fail a commit
            }
        }
        return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
    }
    async persist(batches, _context) {
        let parent = this.head;
        for (const batch of batches) {
            const blob = await this.repo.writeBlob(JSON.stringify(batch));
            const tree = await this.repo.writeTree({ [BATCH_FILE]: blob });
            parent = await this.repo.writeCommit({
                tree,
                parents: parent === undefined ? [] : [parent],
                author: this.author,
                message: commitMessage(batch),
            });
        }
        await this.repo.updateRef(this.ref, parent, this.head, this.reflog ? `pi-durable: seq ${batches.at(-1).seq}` : undefined);
        this.head = parent;
    }
    async mintId() {
        return this.store.mintId();
    }
    async conversation(...args) {
        return (await this.readable()).conversation(...args);
    }
    async scanConversations(...args) {
        return (await this.readable()).scanConversations(...args);
    }
    entry = (async (...args) => (await this.readable()).entry(...args));
    async findLatestHeadMarker(...args) {
        return (await this.readable()).findLatestHeadMarker(...args);
    }
    async scanEntries(...args) {
        return (await this.readable()).scanEntries(...args);
    }
    async task(...args) {
        return (await this.readable()).task(...args);
    }
    async scanTasks(...args) {
        return (await this.readable()).scanTasks(...args);
    }
    async submission(...args) {
        return (await this.readable()).submission(...args);
    }
    async scanSubmissions(...args) {
        return (await this.readable()).scanSubmissions(...args);
    }
    async submissionByRequest(...args) {
        return (await this.readable()).submissionByRequest(...args);
    }
    async findDocument(...args) {
        return (await this.readable()).findDocument(...args);
    }
    async document(...args) {
        return (await this.readable()).document(...args);
    }
    async scanDocuments(...args) {
        return (await this.readable()).scanDocuments(...args);
    }
    async close(context) {
        if (this.closed)
            return;
        this.closed = true;
        await this.queue;
        await this.memory.close(context);
        await this.repo.close();
    }
    get store() {
        this.assertUsable();
        return this.memory;
    }
    async readable() {
        while (this.writing !== undefined)
            await this.writing;
        return this.store;
    }
    poison(cause) {
        this.poisonError ??= new GitStoragePoisonedError(cause);
        return this.poisonError;
    }
    assertUsable() {
        if (this.closed)
            throw new Error("GitStorage is closed");
        if (this.poisonError !== undefined)
            throw this.poisonError;
    }
}
export function openGitStorage(options) {
    return GitStorage.open(options);
}
/** `pi-durable: seq 12 (entry, task×2)` plus trailers, so `git log` reads well. */
function commitMessage(batch) {
    const counts = new Map();
    for (const write of batch.writes)
        counts.set(write.type, (counts.get(write.type) ?? 0) + 1);
    const summary = [...counts].map(([type, n]) => (n === 1 ? type : `${type}×${n}`)).join(", ");
    return `pi-durable: seq ${batch.seq} (${summary})\n\nPi-Durable-Format: ${batch.format}\nPi-Durable-Seq: ${batch.seq}\n`;
}
