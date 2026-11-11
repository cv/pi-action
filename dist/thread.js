import { BACKGROUND_CONTEXT, } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GitStorage } from "./storage/git-storage.js";
import { GitSync, isTurnBoundary, runGit } from "./storage/sync.js";
const context = BACKGROUND_CONTEXT;
export const POSTED_KIND = "pi-action.posted";
export const COMMENT_KIND = "pi-action.comment";
export const threadRef = (issueNumber) => `refs/pi/threads/${issueNumber}`;
/**
 * One GitHub issue or PR as a durable pi conversation, stored in git on refs/pi/threads/<n> and pushed to the
 * remote at every turn boundary.
 */
export class Thread {
    ref;
    isNew;
    /** When the thread's first commit was made; undefined for a new thread. */
    startedAt;
    storage;
    sync;
    harness;
    root;
    log;
    closed = false;
    constructor(init) {
        this.ref = init.ref;
        this.isNew = init.isNew;
        this.startedAt = init.startedAt;
        this.storage = init.storage;
        this.sync = init.sync;
        this.harness = init.harness;
        this.root = init.root;
        this.log = init.log;
    }
    static async open(options) {
        const { cwd, log } = options;
        const ref = threadRef(options.issueNumber);
        const sync = new GitSync({
            repo: cwd,
            ref,
            remote: options.remote,
            log: log.info,
        });
        const remoteTip = await sync.fetch();
        const startedAt = remoteTip ? await rootCommitTime(cwd, ref) : undefined;
        const storage = await GitStorage.open({
            repo: cwd,
            ref,
            author: {
                name: "pi-action",
                email: "pi-action@users.noreply.github.com",
            },
            onCommit: ({ tip, batches }) => {
                if (isTurnBoundary(batches)) {
                    sync
                        .schedule(tip)
                        .catch((error) => log.warning(error.message));
                }
            },
        });
        const registry = createRegistry();
        registry.install(CodingTools);
        const harness = await Harness.open(storage, {
            models: options.models,
            registry,
            env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }),
            settings: { retry: { maxRetries: 2 } },
        }, context);
        const agent = {
            model: { provider: options.model.provider, modelId: options.model.id },
            cwd,
        };
        const root = await harness.root(context, { agent });
        await root.configure(agent, context); // the model may differ from the last run's
        harness.resume(); // finish whatever a previous, interrupted run left
        return new Thread({
            ref,
            isNew: remoteTip === undefined,
            startedAt,
            storage,
            sync,
            harness,
            root,
            log,
        });
    }
    /** The newest local commit of the thread. */
    get tip() {
        return this.storage.tip;
    }
    /** Comments arriving while a run works join it (steer); otherwise they start one. */
    submit(input) {
        return this.root.submit({
            type: "input",
            content: input.content,
            requestId: input.key,
            whenBusy: "steer",
            entry: { kind: COMMENT_KIND, data: { key: input.key, ...input.data } },
        }, context);
    }
    async answerText(answer) {
        const entry = await this.root.commit((tx) => tx.entry(AssistantEntry, answer), context);
        const message = entry?.model?.[0];
        if (!message || message.role !== "assistant") {
            return "";
        }
        return message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("")
            .trim();
    }
    async entries() {
        const all = [];
        let cursor;
        do {
            const page = await this.root.entries({ order: "ascending" }, 500, cursor, context);
            all.push(...page.items);
            cursor = page.next;
        } while (cursor !== undefined);
        return all;
    }
    /** Results already posted to GitHub (`answer-<entryId>`, `error-<submissionId>`), with their comment URLs. */
    async postedResults() {
        const posted = new Map();
        for (const entry of await this.entries()) {
            const data = entry.data;
            if (entry.kind === POSTED_KIND && typeof data?.key === "string") {
                posted.set(data.key, String(data.url ?? ""));
            }
        }
        return posted;
    }
    async markPosted(key, url) {
        await this.root.submit({
            type: "write",
            entry: { kind: POSTED_KIND, data: { key, url } },
            requestId: `posted-${key}`,
        }, context);
    }
    async abort() {
        await this.root.abort(context);
    }
    /** Push what is committed so far; throws if the remote moved under us. */
    async push() {
        await this.sync.flush(this.storage.tip);
    }
    async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await this.harness.close(context);
        await this.push();
    }
}
async function rootCommitTime(cwd, ref) {
    try {
        const { stdout } = await runGit(["rev-list", "--max-parents=0", ref], cwd);
        const root = stdout.trim().split("\n")[0];
        const { stdout: time } = await runGit(["show", "-s", "--format=%cI", root], cwd);
        return new Date(time.trim());
    }
    catch {
        return undefined;
    }
}
