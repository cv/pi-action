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
	type Extension,
	Harness,
	MemoryStorage,
	type Storage,
	type Submission,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { GitStorage } from "./storage/git-storage.ts";
import { git } from "./storage/git.ts";
import { GitSync, isTurnBoundary } from "./storage/sync.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

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
		remote: options.remote,
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
				sync.schedule(tip).catch((error: unknown) => {
					log.warning(getErrorMessage(error));
				});
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
		for (const extension of options.extensions ?? []) {
			registry.install(extension);
		}
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
	async submit(input: ThreadInput): Promise<Submission> {
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
			async (tx) => tx.entry(AssistantEntry, answer),
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

	/** Push what is committed so far; throws if the remote moved under us. */
	async push(): Promise<void> {
		await this.persistence?.sync.flush(this.persistence.storage.tip);
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
