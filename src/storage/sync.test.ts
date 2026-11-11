import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import { GitStorage } from "./git-storage.ts";
import { GitSync, GitSyncConflictError, isTurnBoundary } from "./sync.ts";

const context = BACKGROUND_CONTEXT;
const REF = "refs/pi/threads/7";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});
const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

function world() {
	const root = mkdtempSync(join(tmpdir(), "git-pi-sync-"));
	dirs.push(root);
	const remote = join(root, "remote.git");
	sh(root, "init", "-q", "--bare", "-b", "main", remote);
	const seed = join(root, "seed");
	sh(root, "init", "-q", "-b", "main", seed);
	sh(
		seed,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	sh(seed, "push", "-q", remote, "main");
	const clone = (name: string, ...flags: string[]) => {
		const dir = join(root, name);
		sh(root, "clone", "-q", ...flags, `file://${remote}`, dir);
		return dir;
	};
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	return {
		remote,
		clone,
		faux,
		models,
		agent: { model: { provider: model.provider, modelId: model.id } },
	};
}

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
		const a = await session(w, w.clone("a"), "hello");
		expect(a.settled.status).toBe("done");
		expect(a.pushesAtTurns).toBeGreaterThan(0);
		await a.sync.flush(a.storage.tip);
		expect(sh(w.remote, "rev-parse", REF).trim()).toBe(a.storage.tip);

		// A shallow clone (as actions/checkout makes) still gets the whole chain.
		const b = await session(w, w.clone("b", "--depth", "1"), "again");
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
		const dirA = w.clone("a");
		const dirB = w.clone("b");
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
		const dir = w.clone("a");
		sh(dir, "update-ref", REF, "HEAD");
		const sync = new GitSync({ repo: dir, ref: REF });
		await expect(sync.fetch()).resolves.toBeUndefined();
		expect(() => sh(dir, "rev-parse", "--verify", "-q", REF)).toThrow(
			"Command failed",
		);
	});
});
