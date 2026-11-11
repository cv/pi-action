import {
	BACKGROUND_CONTEXT,
	type Context,
} from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type Conversation,
	type EntryId,
	type EntryRecord,
	Harness,
	type Submission,
	createRegistry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	GitStorage,
	GitSync,
	isTurnBoundary,
	runGit,
} from "./vendor/git-backed-pi-durable/index.js";

const context: Context = BACKGROUND_CONTEXT;

export const POSTED_KIND = "pi-action.posted";
export const COMMENT_KIND = "pi-action.comment";

export const threadRef = (issueNumber: number): string =>
	`refs/pi/threads/${issueNumber}`;

export interface ThreadLogger {
	info: (msg: string) => void;
	warning: (msg: string) => void;
}

export interface ThreadOptions {
	cwd: string;
	issueNumber: number;
	models: Models;
	model: Model<Api>;
	log: ThreadLogger;
	remote?: string;
}

export interface ThreadInput {
	/** Stable per GitHub item, e.g. `comment-123`: resubmitting it returns the same submission. */
	key: string;
	content: string;
	data: { author: string; url?: string; source: string };
}

type EntryData = Record<string, unknown>;

/**
 * One GitHub issue or PR as a durable pi conversation, stored in git on refs/pi/threads/<n> and pushed to the
 * remote at every turn boundary.
 */
export class Thread {
	readonly ref: string;
	readonly isNew: boolean;
	/** When the thread's first commit was made; undefined for a new thread. */
	readonly startedAt: Date | undefined;
	private readonly storage: GitStorage;
	private readonly sync: GitSync;
	private readonly harness: Harness;
	private readonly root: Conversation;
	private readonly log: ThreadLogger;
	private closed = false;

	private constructor(init: {
		ref: string;
		isNew: boolean;
		startedAt: Date | undefined;
		storage: GitStorage;
		sync: GitSync;
		harness: Harness;
		root: Conversation;
		log: ThreadLogger;
	}) {
		this.ref = init.ref;
		this.isNew = init.isNew;
		this.startedAt = init.startedAt;
		this.storage = init.storage;
		this.sync = init.sync;
		this.harness = init.harness;
		this.root = init.root;
		this.log = init.log;
	}

	static async open(options: ThreadOptions): Promise<Thread> {
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
						.catch((error: Error) => log.warning(error.message));
				}
			},
		});
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
	get tip(): string | undefined {
		return this.storage.tip;
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
		if (!message || message.role !== "assistant") {
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

	/** Results already posted to GitHub (`answer-<entryId>`, `error-<submissionId>`), with their comment URLs. */
	async postedResults(): Promise<Map<string, string>> {
		const posted = new Map<string, string>();
		for (const entry of await this.entries()) {
			const data = entry.data as EntryData | undefined;
			if (entry.kind === POSTED_KIND && typeof data?.key === "string") {
				posted.set(data.key, String(data.url ?? ""));
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
		await this.sync.flush(this.storage.tip);
	}

	async close(): Promise<void> {
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
		const root = stdout.trim().split("\n")[0];
		const { stdout: time } = await runGit(
			["show", "-s", "--format=%cI", root],
			cwd,
		);
		return new Date(time.trim());
	} catch {
		return undefined;
	}
}
