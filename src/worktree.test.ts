import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	createRegistry,
	type EntryId,
	Harness,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import { GitStorage } from "./storage/git-storage.ts";
import {
	DEFAULT_SNAPSHOT_LIMITS,
	latestSnapshot,
	worktreeRef,
} from "./storage/worktree.ts";
import {
	createLogger,
	fauxModels,
	git as sh,
	tempRemote,
} from "./test-helpers.ts";
import type { UiQuestion } from "./types.ts";
import {
	CANCEL_OPTION,
	KEEP_OPTION,
	restoreMessage,
	REWIND_OPTION,
	WORKTREE_ENTRY_KIND,
	WorktreeContinuity,
	WorktreeDoc,
} from "./worktree.ts";

const context = BACKGROUND_CONTEXT;
const THREAD = "refs/pi/threads/9";
const REF = worktreeRef(9);

async function setup() {
	const w = tempRemote();
	const dir = w.clone();
	writeFileSync(join(dir, "file.txt"), "base\n");
	sh(dir, "add", "file.txt");
	sh(dir, "commit", "-q", "-m", "base");
	sh(dir, "push", "-q", "origin", "main");
	const { faux, models, agent } = fauxModels();
	const storage = await GitStorage.open({ repo: dir, ref: THREAD });
	const harness = await Harness.open(
		storage,
		{ models, registry: createRegistry() },
		context,
	);
	const root = await harness.root(context, { agent });
	const log = createLogger();
	const continuity = (conversation: Conversation = root) => {
		const c = new WorktreeContinuity({
			cwd: dir,
			ref: REF,
			limits: DEFAULT_SNAPSHOT_LIMITS,
			log,
		});
		c.attach(harness, conversation);
		return c;
	};
	const latestEntry = async (conversation: Conversation = root) => {
		const id = await conversation.commit(
			async (tx) => tx.latestEntryId(conversation.id),
			context,
		);
		if (id === undefined) {
			throw new Error("no entries");
		}
		return id;
	};
	const lastEntry = async () => {
		const id = await latestEntry();
		return root.commit(async (tx) => tx.entry(id), context);
	};
	const forkAt = async (at: EntryId) =>
		root.fork(at, { ownership: { kind: "ownerless" } }, context);
	/** The first parent of the newest wrapper on the ref: the snapshot recorded before it. */
	const previousWrapper = () => sh(dir, "rev-parse", `${REF}^1`).trim();
	const say = async (text: string) => {
		faux.setResponses([fauxAssistantMessage(text)]);
		await (
			await root.submit({ type: "input", content: text }, context)
		).wait(context);
	};
	/** What a fresh runner has: the committed files only. */
	const freshCheckout = () => {
		sh(dir, "reset", "-q", "--hard");
		sh(dir, "clean", "-q", "-fd");
		sh(dir, "checkout", "-q", "main");
	};
	const write = (text: string) => {
		writeFileSync(join(dir, "file.txt"), text);
	};
	const read = () => readFileSync(join(dir, "file.txt"), "utf8");
	return {
		...w,
		dir,
		storage,
		harness,
		root,
		log,
		continuity,
		latestEntry,
		lastEntry,
		forkAt,
		previousWrapper,
		say,
		freshCheckout,
		write,
		read,
	};
}

type World = Awaited<ReturnType<typeof setup>>;

type Ask = (question: UiQuestion) => Promise<{ url?: string }>;

/** The question the guard asked. */
function askedQuestion(ask: {
	mock: { calls: Parameters<Ask>[] };
}): UiQuestion {
	const [call] = ask.mock.calls;
	if (call === undefined) {
		throw new Error("nothing was asked");
	}
	return call[0];
}

const answerTo = (question: UiQuestion, choice: string) => ({
	key: question.key,
	kind: "select" as const,
	answer: choice,
	by: "octo",
	url: "https://q",
	title: question.title,
});

describe("WorktreeContinuity", () => {
	it("saves only when the files changed, and points the conversation at each snapshot", async () => {
		const s = await setup();
		const c = s.continuity();
		await expect(c.checkpoint(s.storage.tip)).resolves.toBeUndefined();
		s.write("one\n");
		const first = await c.checkpoint(s.storage.tip);
		expect(first).toBeDefined();
		await expect(c.checkpoint(s.storage.tip)).resolves.toBeUndefined();
		const doc = await s.harness.snapshot(WorktreeDoc, s.root.id, context);
		expect(doc?.wrapper).toBe(first);
		const marker = await s.lastEntry();
		expect(marker?.kind).toBe(WORKTREE_ENTRY_KIND);
		expect(marker?.model).toBeUndefined();
		const latest = await latestSnapshot(s.dir, REF);
		expect(latest?.threadTip).toBeDefined();
		expect(latest?.wrapper).toBe(first);
	});

	it("restores what the conversation points at into a fresh checkout", async () => {
		const s = await setup();
		s.write("pi's edit\n");
		await s.continuity().checkpoint(s.storage.tip);
		s.freshCheckout();
		expect(s.read()).toBe("base\n");
		const c = s.continuity();
		await expect(c.restore()).resolves.toMatchObject({
			kind: "ready",
			message: expect.stringContaining(
				"Staged and unstaged changes are as they were",
			),
		});
		expect(s.read()).toBe("pi's edit\n");
		// The restored state is the saved one: nothing new to save.
		await expect(c.checkpoint(s.storage.tip)).resolves.toBeUndefined();
	});

	it("starts clean without a message when the conversation has no snapshot", async () => {
		const s = await setup();
		await expect(s.continuity().restore()).resolves.toStrictEqual({
			kind: "ready",
			message: undefined,
		});
	});

	it("gives a fork the snapshot as of its fork entry, not the newest one", async () => {
		const s = await setup();
		const c = s.continuity();
		s.write("first\n");
		const first = await c.checkpoint(s.storage.tip);
		const forkPoint = await s.latestEntry();
		await s.say("later");
		s.write("second\n");
		const second = await c.checkpoint(s.storage.tip);
		expect(second).not.toBe(first);
		const fork = await s.forkAt(forkPoint);
		const target = await s.continuity(fork).target();
		expect(target?.wrapper).toBe(first);
		await expect(s.continuity().target()).resolves.toMatchObject({
			wrapper: second,
		});
	});

	describe("the guard, when the conversation points at an older snapshot", () => {
		/** A snapshot, a fork at its marker entry, and (the caller adds) a newer snapshot on the root. */
		async function rewound() {
			const s = await setup();
			const c = s.continuity();
			s.write("older\n");
			await c.checkpoint(s.storage.tip);
			const fork = await s.forkAt(await s.latestEntry());
			return { s, fork };
		}

		it("restores silently when the newer snapshot only has work that was pushed", async () => {
			const s = await setup();
			const c = s.continuity();
			s.write("committed later\n");
			await c.checkpoint(s.storage.tip);
			const forkPoint = await s.latestEntry();
			sh(s.dir, "commit", "-q", "-am", "pushed");
			sh(s.dir, "push", "-q", "origin", "main");
			const pushed = await c.checkpoint(s.storage.tip);
			expect(pushed).toBeDefined();
			const fork = await s.forkAt(forkPoint);
			s.freshCheckout();
			sh(s.dir, "reset", "-q", "--hard", "origin/main");
			const ask = vi.fn<Ask>();
			const result = await s.continuity(fork).restore({ ask });
			expect(ask).not.toHaveBeenCalled();
			expect(result.kind).toBe("ready");
			// The newest snapshot is now the restored one; the newer stays below it on the ref.
			expect(s.previousWrapper()).toBe(pushed);
			const doc = await s.harness.snapshot(WorktreeDoc, fork.id, context);
			expect(doc?.wrapper).toBe(sh(s.dir, "rev-parse", REF).trim());
		});

		/** The guard's question, asked: a newer snapshot on the root has work only it has. */
		async function asked() {
			const { s, fork } = await rewound();
			s.write("newer, unique\n");
			const newer = await s.continuity().checkpoint(s.storage.tip);
			s.freshCheckout();
			const ask = vi.fn<Ask>(async () => ({ url: "https://q" }));
			const result = await s.continuity(fork).restore({ ask });
			const answer = (choice: string) => answerTo(askedQuestion(ask), choice);
			return { s, fork, ask, result, newer, answer };
		}

		it("asks, without touching the files, when the newer snapshot has work that exists nowhere else", async () => {
			const { s, ask, result } = await asked();
			expect(result).toStrictEqual({ kind: "asked", url: "https://q" });
			expect(s.read()).toBe("base\n");
			const question = askedQuestion(ask);
			expect(question).toMatchObject({
				kind: "select",
				options: [REWIND_OPTION, KEEP_OPTION, CANCEL_OPTION],
			});
			expect(question.title).toContain("`file.txt`");
		});

		it.each([
			[CANCEL_OPTION, "base\n", { kind: "cancelled" }],
			[KEEP_OPTION, "newer, unique\n", { kind: "ready" }],
			[REWIND_OPTION, "older\n", { kind: "ready" }],
		])("answered %o: the files are %o", async (choice, files, kind) => {
			const { s, fork, ask, answer } = await asked();
			const c = s.continuity(fork);
			await expect(
				c.restore({ ask, answer: answer(choice) }),
			).resolves.toMatchObject(kind);
			expect(c.answered).toBe(true);
			expect(s.read()).toBe(files);
		});

		it("keeps the newer snapshot on the ref after a rewind, and doesn't ask again", async () => {
			const { s, fork, ask, newer, answer } = await asked();
			await s.continuity(fork).restore({ ask, answer: answer(REWIND_OPTION) });
			expect(s.previousWrapper()).toBe(newer);
			// Next run: the conversation and the newest snapshot agree, so nothing is asked.
			s.freshCheckout();
			ask.mockClear();
			await s.continuity(fork).restore({ ask });
			expect(ask).not.toHaveBeenCalled();
			expect(s.read()).toBe("older\n");
		});

		it("keeps the newest files and says why when nobody can answer", async () => {
			const { s, fork } = await rewound();
			s.write("newer, unique\n");
			await s.continuity().checkpoint(s.storage.tip);
			s.freshCheckout();
			await expect(s.continuity(fork).restore({})).resolves.toMatchObject({
				message: expect.stringContaining("nobody could be asked"),
			});
			expect(s.read()).toBe("newer, unique\n");
			expect(s.log.warning).toHaveBeenCalledWith(
				expect.stringContaining("the files were not rewound"),
			);
		});
	});

	it.each<{
		name: string;
		spoil: (s: World) => Promise<void> | void;
		message: string;
		files: string;
	}>([
		{
			name: "doesn't restore into a checkout with uncommitted changes",
			spoil: (s: World) => {
				s.write("someone else's\n");
			},
			message: "already had uncommitted changes",
			files: "someone else's\n",
		},
		{
			name: "reports a restore failure and starts clean",
			// The snapshot's commits are gone (say, a bad ref): the restore fails and the run starts clean.
			spoil: async (s: World) => {
				sh(s.dir, "update-ref", "-d", REF);
				await s.root.commit(async (tx) => {
					(await tx.doc(WorktreeDoc, s.root.id)).wrapper = "0".repeat(40);
				}, context);
			},
			message: "started from a clean checkout",
			files: "base\n",
		},
	])("$name", async ({ spoil, message, files }) => {
		const s = await setup();
		s.write("pi's\n");
		await s.continuity().checkpoint(s.storage.tip);
		s.freshCheckout();
		await spoil(s);
		await expect(s.continuity().restore()).resolves.toMatchObject({
			message: expect.stringContaining(message),
		});
		expect(s.read()).toBe(files);
	});
});

describe("restoreMessage", () => {
	const record = {
		wrapper: "w".repeat(40),
		stash: "a".repeat(40),
		head: "b".repeat(40),
		branch: "main",
		threadTip: undefined,
		threadEntry: undefined,
		skipped: [{ path: ".env", reason: "matches worktree_snapshot_exclude" }],
	};

	it("lists conflicts, unstaged restores, and skipped files", () => {
		const message = restoreMessage(
			{
				status: "restored",
				staged: false,
				conflicts: ["a.txt"],
				branch: "main",
				head: "c".repeat(40),
				moved: true,
			},
			record,
		);
		expect(message).toContain("all changes are unstaged");
		expect(message).toContain("conflict markers");
		expect(message).toContain("`a.txt`");
		expect(message).toContain("merged onto it");
		expect(message).toContain("`.env` (matches worktree_snapshot_exclude)");
	});

	it.each([
		[
			"a diverged branch",
			{
				status: "diverged",
				branch: "main",
				head: "b".repeat(40),
				remoteHead: "d".repeat(40),
			},
			"git stash apply --index aaaaaaa",
		],
		["a failure", { status: "failed", error: "boom" }, "failed (boom)"],
	] as const)(
		"explains %s, with the snapshot's sha",
		(_name, outcome, text) => {
			const message = restoreMessage(outcome, record);
			expect(message).toContain(text);
			expect(message).toContain("a".repeat(40));
		},
	);
});
