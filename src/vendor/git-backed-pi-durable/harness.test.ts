// Vendored from github.com/cv/git-backed-pi-durable (1b9ba48).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { GitRepo, GitStorage, RefConflictError } from "./index.js";
import { tempRepo } from "./test-repo.js";

const context = BACKGROUND_CONTEXT;
const REF = "refs/pi/threads/42";
let cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function setup() {
	const repo = tempRepo();
	cleanups.push(repo.cleanup);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const agent = { model: { provider: model.provider, modelId: model.id } };
	const open = async (storage?: GitStorage) => {
		const s = storage ?? (await GitStorage.open({ repo: repo.dir, ref: REF }));
		const harness = await Harness.open(s, { models, registry: createRegistry() }, context);
		return { storage: s, harness, root: await harness.root(context, { agent }) };
	};
	return { repo, faux, open };
}

async function ask(root: Awaited<ReturnType<ReturnType<typeof setup>["open"]>>["root"], content: string) {
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	return (entry?.model?.[0] as any).content.map((c: any) => c.text).join("");
}

describe("GitStorage with a Harness", () => {
	it("persists a conversation as a commit chain and resumes it after reopening", async () => {
		const { repo, faux, open } = setup();
		faux.setResponses([fauxAssistantMessage("Paris"), fauxAssistantMessage("Lyon")]);

		const first = await open();
		expect(await ask(first.root, "Capital of France?")).toBe("Paris");
		const tip = first.storage.tip;
		await first.harness.close(context);

		expect(repo.git("rev-parse", REF).trim()).toBe(tip);
		const log = repo.git("log", "--format=%s", REF).trim().split("\n");
		expect(log.length).toBeGreaterThan(2);
		expect(log.at(-1)).toMatch(/^pi-durable: seq 1 /);
		repo.git("fsck", "--strict", "--no-dangling");

		const second = await open();
		expect(await ask(second.root, "Second city?")).toBe("Lyon");
		const { items } = await second.root.entries({ order: "ascending" } as any, 100, undefined, context);
		const users = items.filter((e: any) => e.kind === "pi.user").map((e: any) => e.model[0].content);
		expect(users).toEqual(["Capital of France?", "Second city?"]);
		await second.harness.close(context);
		// The second session extended the same chain.
		expect(repo.git("merge-base", "--is-ancestor", tip!, REF)).toBe("");
	});

	it("reopens after git gc packs objects and refs", async () => {
		const { repo, faux, open } = setup();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const first = await open();
		await ask(first.root, "1");
		await first.harness.close(context);

		repo.git("gc", "-q", "--prune=now");
		expect(repo.git("count-objects", "-v")).toMatch(/^count: 0$/m);
		expect(repo.git("show-ref")).toContain(REF);

		const second = await open();
		expect(await ask(second.root, "2")).toBe("two");
		await second.harness.close(context);
		repo.git("fsck", "--strict", "--no-dangling");
	});

	it("refuses to fork the log when another writer moved the ref", async () => {
		const { repo, faux, open } = setup();
		faux.setResponses([fauxAssistantMessage("a")]);
		const first = await open();
		await ask(first.root, "a");
		await first.harness.close(context);

		const stale = await GitStorage.open({ repo: repo.dir, ref: REF });
		const other = await GitStorage.open({ repo: repo.dir, ref: REF });
		const id = await other.mintId();
		await other.commit([[{ type: "conversation", value: { id, ownership: { kind: "ownerless" } } as any }]], () => {}, context);
		await other.close(context);

		const staleId = await stale.mintId();
		await expect(
			stale.commit([[{ type: "conversation", value: { id: staleId, ownership: { kind: "ownerless" } } as any }]], () => {}, context),
		).rejects.toThrow(/poisoned/);
		await stale.close(context);
	});

	it("updateRef is a compare-and-swap", async () => {
		const { repo } = setup();
		const git = await GitRepo.open(repo.dir);
		const blob = await git.writeBlob("x");
		const tree = await git.writeTree({ "x.txt": blob });
		const author = { name: "t", email: "t@t" };
		const a = await git.writeCommit({ tree, parents: [], author, message: "a\n" });
		const b = await git.writeCommit({ tree, parents: [a], author, message: "b\n" });
		await git.updateRef("refs/pi/x", a, undefined);
		await expect(git.updateRef("refs/pi/x", b, undefined)).rejects.toBeInstanceOf(RefConflictError);
		await git.updateRef("refs/pi/x", b, a);
		expect(repo.git("rev-parse", "refs/pi/x").trim()).toBe(b);
		expect(repo.git("cat-file", "-p", "refs/pi/x:x.txt")).toBe("x");
		await git.close();
	});
});
