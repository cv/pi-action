import {
	appendFileSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { tempRepo } from "../test-helpers.js";
import { assertRefName, GitRepo, RefConflictError } from "./git.js";
import { GitStorage } from "./git-storage.js";

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
const NOT_A_COMMIT = /is a blob, not a commit/u;
const NOT_A_TREE = /is a commit, not a tree/u;
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
	it("opens work trees, git dirs, bare repos, and linked worktrees", async () => {
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
		for (const path of [r.dir, join(r.dir, ".git"), linked]) {
			// biome-ignore lint/performance/noAwaitInLoops: one at a time
			const git = await GitRepo.open(path);
			expect(realpathSync(git.commonDir)).toBe(
				realpathSync(join(r.dir, ".git")),
			);
			await git.close();
		}
		const bare = repo();
		bare.git("init", "-q", "--bare", "b.git");
		const git = await GitRepo.open(join(bare.dir, "b.git"));
		expect(realpathSync(git.commonDir)).toBe(
			realpathSync(join(bare.dir, "b.git")),
		);
	});

	it("refuses non-repositories and unsupported formats", async () => {
		const r = repo();
		await expect(GitRepo.open(join(r.dir, "nowhere"))).rejects.toThrow(
			NOT_A_REPO,
		);
		writeFileSync(join(r.dir, "sub.git"), "nonsense\n");
		mkdirSync(join(r.dir, "wt"));
		writeFileSync(join(r.dir, "wt", ".git"), "not a gitdir line\n");
		await expect(GitRepo.open(join(r.dir, "wt"))).rejects.toThrow(
			"Malformed .git file",
		);
		const reftable = repo();
		appendFileSync(
			join(reftable.dir, ".git", "config"),
			"[extensions]\n\trefStorage = reftable\n",
		);
		await expect(GitRepo.open(reftable.dir)).rejects.toThrow("reftable");
		const sha256 = repo();
		appendFileSync(
			join(sha256.dir, ".git", "config"),
			"[extensions]\n\tobjectFormat = sha256\n",
		);
		await expect(GitRepo.open(sha256.dir)).rejects.toThrow("sha256");
	});

	it("reads loose and packed objects and refs, and reports missing or mistyped ones", async () => {
		const r = repo();
		const git = await GitRepo.open(r.dir);
		const tip = await commitChain(git, [
			{ "a.txt": "one" },
			{ "a.txt": "two" },
		]);
		await git.updateRef("refs/pi/x", tip, undefined);
		const commit = await git.readCommit(tip);
		expect(commit.parents).toHaveLength(1);
		expect(await git.readTree(commit.tree)).toHaveProperty("a.txt");
		await git.close();

		r.git("gc", "-q", "--prune=now");
		const packed = await GitRepo.open(r.dir);
		expect(await packed.readRef("refs/pi/x")).toBe(tip);
		const tree = await packed.readTree((await packed.readCommit(tip)).tree);
		const blob = String(tree["a.txt"]);
		expect((await packed.readObject(blob)).content.toString()).toBe("two");
		await expect(packed.readObject("0".repeat(40))).rejects.toThrow(MISSING);
		await expect(packed.readCommit(blob)).rejects.toThrow(NOT_A_COMMIT);
		await expect(packed.readTree(tip)).rejects.toThrow(NOT_A_TREE);
		await expect(packed.readObject("nope")).rejects.toThrow("Bad object id");
		expect(await packed.readRef("refs/pi/none")).toBeUndefined();
		await packed.close();
	});

	it("rejects symbolic refs, bad ids, and bad tree entries", async () => {
		const r = repo();
		const git = await GitRepo.open(r.dir);
		mkdirSync(join(r.dir, ".git", "refs", "pi"), { recursive: true });
		writeFileSync(
			join(r.dir, ".git", "refs", "pi", "sym"),
			"ref: refs/heads/main\n",
		);
		await expect(git.readRef("refs/pi/sym")).rejects.toThrow(NOT_DIRECT);
		await expect(git.updateRef("refs/pi/y", "nope", undefined)).rejects.toThrow(
			"Bad object id",
		);
		await expect(git.writeTree({ "a/b": "0".repeat(40) })).rejects.toThrow(
			"Bad tree entry",
		);
		await expect(git.writeTree({ a: "zz" })).rejects.toThrow("Bad tree entry");
	});

	it("treats a held lock as a conflict and can write a reflog", async () => {
		const r = repo();
		const git = await GitRepo.open(r.dir);
		const tip = await commitChain(git, [{ f: "x" }]);
		mkdirSync(join(r.dir, ".git", "refs", "pi"), { recursive: true });
		writeFileSync(join(r.dir, ".git", "refs", "pi", "z.lock"), "");
		await expect(
			git.updateRef("refs/pi/z", tip, undefined),
		).rejects.toBeInstanceOf(RefConflictError);
		await git.updateRef("refs/pi/w", tip, undefined, "first");
		expect(r.git("reflog", "show", "--format=%gs", "refs/pi/w").trim()).toBe(
			"first",
		);
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
				tree: (await git.readCommit(tip)).tree,
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

	it("can open read-only and with fsync and a reflog", async () => {
		const r = repo();
		const writer = await GitStorage.open({
			repo: r.dir,
			ref: "refs/pi/m",
			fsync: true,
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
