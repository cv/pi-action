import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { fauxModels, git as sh, tempRemote } from "../test-helpers.ts";
import { GitStorage } from "./git-storage.ts";
import { GitSync, GitSyncConflictError, isTurnBoundary } from "./sync.ts";

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
