import {
	BACKGROUND_CONTEXT,
	type Context,
} from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	type EntryId,
	type EntryRecord,
	Harness,
	MemoryStorage,
	type Storage,
	type Submission,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GitStorage } from "./storage/git-storage.js";
import { GitSync, isTurnBoundary, runGit } from "./storage/sync.js";

const context: Context = BACKGROUND_CONTEXT;

const POSTED_KIND = "pi-action.posted";
const COMMENT_KIND = "pi-action.comment";
const KEY_FIELD = "key";
const URL_FIELD = "url";

export const threadRef = (issueNumber: number): string =>
	`refs/pi/threads/${issueNumber}`;

interface ThreadLogger {
	info: (msg: string) => void;
	warning: (msg: string) => void;
}

export interface ThreadOptions {
	cwd: string;
	/** The issue or PR; undefined for a one-off prompt, which is kept in memory only. */
	issueNumber?: number | undefined;
	models: Models;
	model: Model<Api>;
	log: ThreadLogger;
	remote?: string | undefined;
}

export interface ThreadInput {
	/** Stable per GitHub item, e.g. `comment-123`: resubmitting it returns the same submission. */
	key: string;
	content: string;
	data: Record<string, string>;
}

interface Persistence {
	ref: string;
	storage: GitStorage;
	sync: GitSync;
	startedAt: Date | undefined;
	isNew: boolean;
}

async function openPersistence(
	options: ThreadOptions,
	issueNumber: number,
): Promise<Persistence> {
	const { cwd, log } = options;
	const ref = threadRef(issueNumber);
	const sync = new GitSync({
		repo: cwd,
		ref,
		log: log.info,
		...(options.remote ? { remote: options.remote } : {}),
	});
	const remoteTip = await sync.fetch();
	const storage = await GitStorage.open({
		repo: cwd,
		ref,
		author: {
			name: "pi-action",
			email: "pi-action@users.noreply.github.com",
		},
		onCommit: ({ tip, batches }) => {
			if (isTurnBoundary(batches)) {
				sync.schedule(tip).catch((error: Error) => log.warning(error.message));
			}
		},
	});
	return {
		ref,
		storage,
		sync,
		isNew: remoteTip === undefined,
		startedAt: remoteTip ? await rootCommitTime(cwd, ref) : undefined,
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
		const storage: Storage = persistence?.storage ?? new MemoryStorage();
		const registry = createRegistry();
		registry.install(CodingTools);
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }),
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
		harness.resume(); // finish whatever a previous, interrupted run left
		return new Thread(harness, root, persistence);
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
	submit(input: ThreadInput): Promise<Submission> {
		return this.root.submit(
			{
				type: "input",
				content: input.content,
				requestId: input.key,
				whenBusy: "steer",
				entry: { kind: COMMENT_KIND, data: { key: input.key, ...input.data } },
			},
			context,
		);
	}

	async answerText(answer: EntryId): Promise<string> {
		const entry = await this.root.commit(
			(tx) => tx.entry(AssistantEntry, answer),
			context,
		);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") {
			return "";
		}
		return message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("")
			.trim();
	}

	async entries(): Promise<EntryRecord[]> {
		const all: EntryRecord[] = [];
		let cursor: Parameters<Conversation["entries"]>[2];
		do {
			// biome-ignore lint/performance/noAwaitInLoops: pages follow each other
			const page = await this.root.entries(
				{ order: "ascending" },
				500,
				cursor,
				context,
			);
			all.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return all;
	}

	/** Results already posted (`answer-<entryId>`, `error-<submissionId>`), with their comment URLs. */
	async postedResults(): Promise<Map<string, string>> {
		const posted = new Map<string, string>();
		for (const entry of await this.entries()) {
			const data = entry.data as Record<string, unknown> | undefined;
			const key = data?.[KEY_FIELD];
			if (entry.kind === POSTED_KIND && typeof key === "string") {
				posted.set(key, String(data?.[URL_FIELD] ?? ""));
			}
		}
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

	/** Push what is committed so far; throws if the remote moved under us. */
	async push(): Promise<void> {
		await this.persistence?.sync.flush(this.persistence.storage.tip);
	}

	async close(): Promise<void> {
		// biome-ignore lint/suspicious/noUnnecessaryConditions: close() may be called twice
		if (this.closed) {
			return;
		}
		this.closed = true;
		await this.harness.close(context);
		await this.push();
	}
}

async function rootCommitTime(
	cwd: string,
	ref: string,
): Promise<Date | undefined> {
	try {
		const { stdout } = await runGit(["rev-list", "--max-parents=0", ref], cwd);
		const [root = ref] = stdout.trim().split("\n");
		const { stdout: time } = await runGit(
			["show", "-s", "--format=%cI", root],
			cwd,
		);
		return new Date(time.trim());
	} catch {
		return;
	}
}
