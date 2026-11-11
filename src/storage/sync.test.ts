import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { fauxModels, git as sh, tempRemote } from "../test-helpers.ts";
import { GitStorage } from "./git-storage.ts";
import { git, GitError } from "./git.ts";
import {
	type GitRunner,
	GitSync,
	GitSyncConflictError,
	isTurnBoundary,
} from "./sync.ts";

const context = BACKGROUND_CONTEXT;
const REF = "refs/pi/threads/7";
const world = () => ({ ...tempRemote(), ...fauxModels() });

async function session(
	w: ReturnType<typeof world>,
	dir: string,
	prompt: string,
	fetch = true,
) {
	const sync = new GitSync({ repo: dir, ref: REF });
	if (fetch) {
		await sync.fetch();
	}
	const pushes: Promise<void>[] = [];
	const storage = await GitStorage.open({
		repo: dir,
		ref: REF,
		onCommit: ({ tip, batches }) => {
			if (isTurnBoundary(batches)) {
				pushes.push(sync.schedule(tip).catch(() => undefined));
			}
		},
	});
	const harness = await Harness.open(
		storage,
		{ models: w.models, registry: createRegistry() },
		context,
	);
	const root = await harness.root(context, { agent: w.agent });
	const settled = await (
		await root.submit({ type: "input", content: prompt }, context)
	).wait(context);
	await harness.close(context);
	await Promise.all(pushes);
	return { sync, storage, settled, pushesAtTurns: pushes.length };
}

describe("GitSync", () => {
	it("pushes at turn boundaries and continues the thread from another clone", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
		]);
		const a = await session(w, w.clone(), "hello");
		expect(a.settled.status).toBe("done");
		expect(a.pushesAtTurns).toBeGreaterThan(0);
		await a.sync.flush(a.storage.tip);
		expect(sh(w.remote, "rev-parse", REF).trim()).toBe(a.storage.tip);

		// A shallow clone (as actions/checkout makes) still gets the whole chain.
		const b = await session(w, w.clone("--depth", "1"), "again");
		expect(b.settled.status).toBe("done");
		await b.sync.flush(b.storage.tip);
		expect(
			sh(w.remote, "merge-base", "--is-ancestor", String(a.storage.tip), REF),
		).toBe("");
		const users = sh(w.remote, "log", "--format=%s", REF)
			.split("\n")
			.filter(Boolean);
		expect(users.length).toBeGreaterThan(5);
	});

	it("refuses to overwrite a thread another writer pushed meanwhile", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage("1"),
			fauxAssistantMessage("2"),
			fauxAssistantMessage("3"),
		]);
		const dirA = w.clone();
		const dirB = w.clone();
		const first = await session(w, dirA, "one");
		await first.sync.flush(first.storage.tip);

		// Both start from the same remote state...
		const syncB = new GitSync({ repo: dirB, ref: REF });
		await syncB.fetch();
		const b = await session(w, dirB, "two", false);
		await syncB.flush(b.storage.tip);
		// ...A, not refetching, extends its stale copy and loses the race.
		const a = await session(w, dirA, "three", false);
		const stale = new GitSync({ repo: dirA, ref: REF });
		await expect(stale.flush(a.storage.tip)).rejects.toBeInstanceOf(
			GitSyncConflictError,
		);
		expect(sh(w.remote, "rev-parse", REF).trim()).toBe(b.storage.tip);
	});

	it("fetch of a thread the remote doesn't have clears the local ref", async () => {
		const w = world();
		const dir = w.clone();
		sh(dir, "update-ref", REF, "HEAD");
		const sync = new GitSync({ repo: dir, ref: REF });
		await expect(sync.fetch()).resolves.toBeUndefined();
		expect(() => sh(dir, "rev-parse", "--verify", "-q", REF)).toThrow(
			"Command failed",
		);
	});
});

/** The stderr GitHub sent when it failed to update a ref (run 42990775045), not because another writer moved it. */
const REMOTE_FAILED = (tip: string, args: readonly string[]) =>
	new GitError(
		args,
		`To https://github.com/o/r\n ! [remote rejected] ${tip} -> ${REF} (failed)\nerror: failed to push some refs to 'https://github.com/o/r'`,
	);

/** Real git, except that the next `failures` pushes fail with `failure`; records the pushes it was asked for. */
function flakyGit(
	failures: number,
	failure: (tip: string, args: readonly string[]) => Error,
) {
	let left = failures;
	const pushes: string[] = [];
	const run: GitRunner = async (dir, args) => {
		if (args[0] === "push") {
			const tip = args.at(-1)?.split(":")[0] ?? "";
			pushes.push(tip);
			if (left > 0) {
				left -= 1;
				throw failure(tip, args);
			}
		}
		return git(dir, args);
	};
	return { run, pushes };
}

/** A clone of a fresh remote and two commits on top of main to push to REF. */
function twoTips() {
	const w = tempRemote();
	const dir = w.clone();
	const first = sh(
		dir,
		"commit-tree",
		"-p",
		"HEAD",
		"-m",
		"1",
		"HEAD^{tree}",
	).trim();
	const second = sh(
		dir,
		"commit-tree",
		"-p",
		first,
		"-m",
		"2",
		"HEAD^{tree}",
	).trim();
	const remoteTip = () => sh(w.remote, "rev-parse", REF).trim();
	return { dir, first, second, remoteTip };
}

describe("GitSync push failures", () => {
	it("retries a push the remote failed (not a conflict) after a backoff", async () => {
		const { dir, first, remoteTip } = twoTips();
		const flaky = flakyGit(2, REMOTE_FAILED);
		const log: string[] = [];
		const sync = new GitSync({
			repo: dir,
			ref: REF,
			git: flaky.run,
			retryDelaysMs: [0, 0, 0],
			log: (m) => {
				log.push(m);
			},
		});
		await sync.schedule(first);
		expect(flaky.pushes).toStrictEqual([first, first, first]);
		expect(remoteTip()).toBe(first);
		expect(log.filter((m) => m.includes("retrying in 0 ms"))).toHaveLength(2);
		expect(log.at(-1)).toBe(`${REF}: pushed ${first.slice(0, 7)}`);
	});

	it("gives up after the retries without stopping later pushes", async () => {
		const { dir, first, second, remoteTip } = twoTips();
		const flaky = flakyGit(3, REMOTE_FAILED);
		const sync = new GitSync({
			repo: dir,
			ref: REF,
			git: flaky.run,
			retryDelaysMs: [0, 0],
		});
		const failed = sync.schedule(first);
		await expect(failed).rejects.toThrow(
			`Push of ${REF} failed (3 attempts): To https://github.com/o/r`,
		);
		await expect(failed).rejects.not.toBeInstanceOf(GitSyncConflictError);
		expect(flaky.pushes).toHaveLength(3);
		// The next turn boundary pushes again, and the run's final flush does too.
		await sync.schedule(second);
		expect(remoteTip()).toBe(second);
		await expect(sync.flush(second)).resolves.toBeUndefined();
		expect(flaky.pushes).toHaveLength(4);
	});

	it("flush retries a tip whose scheduled push failed", async () => {
		const { dir, first, remoteTip } = twoTips();
		const flaky = flakyGit(1, REMOTE_FAILED);
		const sync = new GitSync({
			repo: dir,
			ref: REF,
			git: flaky.run,
			retryDelaysMs: [],
		});
		await expect(sync.schedule(first)).rejects.toThrow("(1 attempts)");
		await sync.flush(first);
		expect(remoteTip()).toBe(first);
	});

	it.each(["fetch first", "non-fast-forward", "stale info"])(
		"treats [rejected] (%s) as a conflict: no retry, and no later push",
		async (reason) => {
			const { dir, first, second } = twoTips();
			const flaky = flakyGit(
				1,
				(_tip, args) =>
					new GitError(
						args,
						` ! [rejected]        HEAD -> ${REF} (${reason})\nerror: failed to push some refs to 'origin'\nhint: Updates were rejected`,
					),
			);
			const sync = new GitSync({
				repo: dir,
				ref: REF,
				git: flaky.run,
				retryDelaysMs: [0, 0, 0],
			});
			await expect(sync.schedule(first)).rejects.toBeInstanceOf(
				GitSyncConflictError,
			);
			await expect(sync.schedule(second)).rejects.toBeInstanceOf(
				GitSyncConflictError,
			);
			await expect(sync.flush(second)).rejects.toBeInstanceOf(
				GitSyncConflictError,
			);
			expect(flaky.pushes).toHaveLength(1);
		},
	);

	it("retries errors that are not git's (spawn failures)", async () => {
		const { dir, first, remoteTip } = twoTips();
		const flaky = flakyGit(1, () => new Error("spawn git EAGAIN"));
		const sync = new GitSync({
			repo: dir,
			ref: REF,
			git: flaky.run,
			retryDelaysMs: [0],
		});
		await sync.schedule(first);
		expect(remoteTip()).toBe(first);
	});
});
