import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { tempRepo } from "../test-helpers.ts";
import { assertRefName, GitRepo, RefConflictError } from "./git.ts";
import { GitStorage } from "./git-storage.ts";

const author = { name: "t", email: "t@t" };
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
});
function repo() {
	const r = tempRepo();
	cleanups.push(r.cleanup);
	return r;
}
async function commitChain(git: GitRepo, files: Record<string, string>[]) {
	let parent: string | undefined;
	for (const content of files) {
		const entries: Record<string, string> = {};
		for (const [name, text] of Object.entries(content)) {
			// biome-ignore lint/performance/noAwaitInLoops: building a chain in order
			entries[name] = await git.writeBlob(text);
		}
		const tree = await git.writeTree(entries);
		parent = await git.writeCommit({
			tree,
			parents: parent ? [parent] : [],
			author,
			message: "m\n",
		});
	}
	return parent ?? "";
}

const BAD_REF = /Invalid ref name/u;
const NOT_A_REPO = /Not a git repository/u;
const MISSING = /is missing/u;
const NOT_DIRECT = /is not a direct ref/u;
const NO_BATCH = /has no batch\.json/u;
const MALFORMED = /Malformed batch\.json/u;
const UNSUPPORTED = /Unsupported or invalid batch/u;
const MERGE = /Merge commit/u;
const READ_ONLY = /read-only/u;

describe("assertRefName", () => {
	it.each(["refs/pi/threads/1", "refs/heads/feature/x"])(
		"accepts %s",
		(ref) => {
			expect(() => assertRefName(ref)).not.toThrow();
		},
	);
	it.each([
		"heads/main",
		"refs/pi/",
		"refs/pi/a..b",
		"refs/pi//a",
		"refs/pi/a@{1}",
		"refs/pi/a b",
		"refs/pi/a~1",
		"refs/pi/.hidden",
		"refs/pi/x.lock",
		"refs/pi/end.",
	])("rejects %s", (ref) => {
		expect(() => assertRefName(ref)).toThrow(BAD_REF);
	});
});

describe("GitRepo", () => {
	it("opens work trees, git dirs, bare repos, and linked worktrees, and refuses anything else", async () => {
		const r = repo();
		r.git(
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
		const linked = join(r.dir, "..", `${r.dir.split("/").at(-1)}-wt`);
		r.git("worktree", "add", "-q", linked);
		cleanups.push(() => rmSync(linked, { recursive: true, force: true }));
		r.git("init", "-q", "--bare", "b.git");
		const tip = await commitChain(await GitRepo.open(r.dir), [{ f: "x" }]);
		for (const path of [join(r.dir, ".git"), linked]) {
			// biome-ignore lint/performance/noAwaitInLoops: one at a time
			const git = await GitRepo.open(path);
			expect((await git.commits(tip)).map((c) => c.id)).toEqual([tip]);
			await git.close();
		}
		await expect(GitRepo.open(join(r.dir, "b.git"))).resolves.toBeInstanceOf(
			GitRepo,
		);
		await expect(GitRepo.open(join(r.dir, "nowhere"))).rejects.toThrow(
			NOT_A_REPO,
		);
	});

	it("reads chains and files, loose or packed, and reports missing or mistyped ones", async () => {
		const r = repo();
		const git = await GitRepo.open(r.dir);
		const tip = await commitChain(git, [
			{ "a.txt": "one" },
			{ "a.txt": "two" },
		]);
		await git.updateRef("refs/pi/x", tip, undefined);
		const chain = await git.commits(tip);
		expect(chain).toHaveLength(2);
		expect(chain[1]).toEqual({ id: tip, parents: [chain[0]?.id] });
		expect((await git.readFile(tip, "a.txt")).toString()).toBe("two");
		await git.close();

		r.git("gc", "-q", "--prune=now");
		const packed = await GitRepo.open(r.dir);
		expect(await packed.readRef("refs/pi/x")).toBe(tip);
		expect((await packed.readFile(tip, "a.txt")).toString()).toBe("two");
		await expect(packed.readFile(tip, "b.txt")).rejects.toThrow(MISSING);
		await expect(packed.readFile("nope", "a.txt")).rejects.toThrow(
			"Bad object id",
		);
		await expect(packed.commits("nope")).rejects.toThrow("Bad object id");
		expect(await packed.readRef("refs/pi/none")).toBeUndefined();
		await packed.close();
	});

	it("moves refs by compare-and-swap, and rejects symbolic refs, bad ids, and bad tree entries", async () => {
		const r = repo();
		const git = await GitRepo.open(r.dir);
		const [one, two] = [
			await commitChain(git, [{ f: "1" }]),
			await commitChain(git, [{ f: "2" }]),
		];
		await git.updateRef("refs/pi/w", one, undefined, "first");
		expect(r.git("reflog", "show", "--format=%gs", "refs/pi/w").trim()).toBe(
			"first",
		);
		await expect(git.updateRef("refs/pi/w", two, undefined)).rejects.toThrow(
			RefConflictError,
		);
		await expect(
			git.updateRef("refs/pi/w", two, "f".repeat(40)),
		).rejects.toMatchObject({ actual: one });
		await git.updateRef("refs/pi/w", two, one);
		expect(await git.readRef("refs/pi/w")).toBe(two);

		mkdirSync(join(r.dir, ".git", "refs", "pi"), { recursive: true });
		writeFileSync(join(r.dir, ".git", "refs", "pi", "z.lock"), "");
		await expect(git.updateRef("refs/pi/z", one, undefined)).rejects.toThrow(
			"(locked)",
		);

		r.git("symbolic-ref", "refs/pi/sym", "refs/heads/main");
		await expect(git.readRef("refs/pi/sym")).rejects.toThrow(NOT_DIRECT);
		await expect(git.updateRef("refs/pi/y", "nope", undefined)).rejects.toThrow(
			"Bad object id",
		);
		await expect(git.writeTree({ "a/b": "0".repeat(40) })).rejects.toThrow(
			"Bad tree entry",
		);
		await expect(git.writeTree({ a: "zz" })).rejects.toThrow("Bad tree entry");
		await git.close();
	});

	it.each([
		["SHA-256", ["--object-format=sha256"]],
		["reftable", ["--ref-format=reftable"]],
	])("works in %s repositories", async (_name, flags) => {
		const r = repo();
		const sub = join(r.dir, "sub");
		try {
			r.git("init", "-q", ...flags, sub);
		} catch {
			return; // this git is too old for the format
		}
		const storage = await GitStorage.open({ repo: sub, ref: "refs/pi/s" });
		const id = await storage.mintId<ConversationId>();
		await storage.commit(
			[
				[
					{
						type: "conversation",
						value: { id, ownership: { kind: "ownerless" } } as never,
					},
				],
			],
			() => undefined,
			BACKGROUND_CONTEXT,
		);
		await storage.close(BACKGROUND_CONTEXT);
		const reopened = await GitStorage.open({ repo: sub, ref: "refs/pi/s" });
		expect(await reopened.conversation(id, BACKGROUND_CONTEXT)).toBeDefined();
		await reopened.close(BACKGROUND_CONTEXT);
	});
});

describe("GitStorage corruption and modes", () => {
	const ctx = BACKGROUND_CONTEXT;
	async function storageWith(files: Record<string, string>[], merge = false) {
		const r = repo();
		const git = await GitRepo.open(r.dir);
		let tip = await commitChain(git, files);
		if (merge) {
			const other = await commitChain(git, [{ "batch.json": "{}" }]);
			tip = await git.writeCommit({
				tree: r.git("rev-parse", `${tip}^{tree}`).trim(),
				parents: [tip, other],
				author,
				message: "merge\n",
			});
		}
		await git.updateRef("refs/pi/t", tip, undefined);
		await git.close();
		return () => GitStorage.open({ repo: r.dir, ref: "refs/pi/t" });
	}

	it("rejects logs it cannot replay", async () => {
		await expect((await storageWith([{ "other.txt": "x" }]))()).rejects.toThrow(
			NO_BATCH,
		);
		await expect(
			(await storageWith([{ "batch.json": "{nope" }]))(),
		).rejects.toThrow(MALFORMED);
		await expect(
			(
				await storageWith([
					{ "batch.json": JSON.stringify({ format: 99, seq: 1, writes: [] }) },
				])
			)(),
		).rejects.toThrow(UNSUPPORTED);
		await expect(
			(
				await storageWith(
					[{ "batch.json": JSON.stringify({ format: 1, seq: 1, writes: [] }) }],
					true,
				)
			)(),
		).rejects.toThrow(MERGE);
	});

	it("can open read-only and with a reflog", async () => {
		const r = repo();
		const writer = await GitStorage.open({
			repo: r.dir,
			ref: "refs/pi/m",
			reflog: true,
		});
		const id = await writer.mintId<ConversationId>();
		await writer.commit(
			[
				[
					{
						type: "conversation",
						value: { id, ownership: { kind: "ownerless" } } as never,
					},
				],
			],
			() => undefined,
			ctx,
		);
		await writer.close(ctx);
		await writer.close(ctx);
		expect(r.git("reflog", "show", "--format=%gs", "refs/pi/m").trim()).toBe(
			"pi-durable: seq 1",
		);

		const reader = await GitStorage.open({
			repo: r.dir,
			ref: "refs/pi/m",
			readOnly: true,
		});
		expect(await reader.conversation(id, ctx)).toBeDefined();
		await expect(reader.commit([[]], () => undefined, ctx)).rejects.toThrow(
			READ_ONLY,
		);
		await reader.close(ctx);
		await expect(reader.mintId()).rejects.toThrow("closed");
	});
});
