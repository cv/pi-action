import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { git as sh, tempRemote } from "../test-helpers.ts";
import {
	captureState,
	DEFAULT_SNAPSHOT_LIMITS,
	isClean,
	isExcluded,
	latestSnapshot,
	readSnapshot,
	recordSnapshot,
	restoreSnapshot,
	type SnapshotRecord,
	stateKey,
	uniqueWork,
	worktreeRef,
	writeStash,
} from "./worktree.ts";

const REF = worktreeRef(7);
const BINARY = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);

const write = (dir: string, path: string, content: string | Buffer) => {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), content);
};
const read = (dir: string, path: string) =>
	readFileSync(join(dir, path), "utf8");
const status = (dir: string) => sh(dir, "status", "--porcelain=v1");

/** A remote whose main has a few files, and a clone of it. */
function world() {
	const w = tempRemote();
	const seed = w.clone();
	write(seed, "keep.txt", "keep\n");
	write(seed, "gone.txt", "gone\n");
	write(seed, "partial.txt", "one\n");
	write(seed, "staged.txt", "s\n");
	write(seed, "run.sh", "#!/bin/sh\necho hi\n");
	write(seed, "conflict.txt", "base\n");
	write(seed, ".gitignore", "node_modules/\n*.log\n");
	sh(seed, "add", ".");
	sh(seed, "commit", "-q", "-m", "files");
	sh(seed, "push", "-q", "origin", "main");
	return { ...w, seed };
}

/** Every kind of change: modified, deleted, staged, partially staged, untracked, executable bit, symlink, binary. */
function makeChanges(dir: string) {
	write(dir, "keep.txt", "keep, changed\n");
	rmSync(join(dir, "gone.txt"));
	write(dir, "staged.txt", "s, staged\n");
	sh(dir, "add", "staged.txt");
	write(dir, "partial.txt", "one\ntwo\n");
	sh(dir, "add", "partial.txt");
	write(dir, "partial.txt", "one\ntwo\nthree\n");
	chmodSync(join(dir, "run.sh"), 0o755);
	write(dir, "deep/nested/dir/new.md", "# new\n");
	write(dir, "blob.bin", BINARY);
	symlinkSync("keep.txt", join(dir, "link"));
	write(dir, "node_modules/x/index.js", "ignored\n");
	write(dir, "debug.log", "ignored\n");
}

async function snapshot(
	dir: string,
	extra: { threadTip?: string; threadEntry?: string } = {},
	limits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<SnapshotRecord> {
	const state = await captureState(dir, limits);
	const stash = await writeStash(dir, state);
	return recordSnapshot(dir, REF, { ...state, stash, ...extra });
}

/** A fresh checkout of main (a new runner) with the snapshot ref fetched. */
function freshCheckout(w: ReturnType<typeof world>, from: string) {
	sh(from, "push", "-q", "origin", `+${REF}:${REF}`);
	const dir = w.clone("--depth", "1");
	sh(dir, "fetch", "-q", "origin", `+${REF}:${REF}`);
	return dir;
}

describe("working-tree snapshots", () => {
	it("round-trips every kind of change, staged vs unstaged included", async () => {
		const w = world();
		const dir = w.clone();
		makeChanges(dir);
		const before = status(dir);
		const record = await snapshot(dir, { threadTip: "abc", threadEntry: "e1" });
		// Capturing touches neither the index nor the files.
		expect(status(dir)).toBe(before);
		expect(record.branch).toBe("main");
		await expect(readSnapshot(dir, record.wrapper)).resolves.toStrictEqual(
			record,
		);
		await expect(latestSnapshot(dir, REF)).resolves.toStrictEqual(record);
		// Git's own tools read it as a stash.
		const shown = sh(
			dir,
			"stash",
			"show",
			"--include-untracked",
			"--name-only",
			record.stash,
		);
		expect(shown.split("\n").filter(Boolean).toSorted()).toStrictEqual([
			"blob.bin",
			"deep/nested/dir/new.md",
			"gone.txt",
			"keep.txt",
			"link",
			"partial.txt",
			"run.sh",
			"staged.txt",
		]);

		const fresh = freshCheckout(w, dir);
		const outcome = await restoreSnapshot(fresh, record);
		expect(outcome).toMatchObject({
			status: "restored",
			staged: true,
			conflicts: [],
			branch: "main",
			moved: false,
		});
		expect(status(fresh)).toBe(before);
		expect(read(fresh, "partial.txt")).toBe("one\ntwo\nthree\n");
		expect(sh(fresh, "show", ":partial.txt")).toBe("one\ntwo\n");
		expect(readFileSync(join(fresh, "blob.bin"))).toStrictEqual(BINARY);
		expect(readlinkSync(join(fresh, "link"))).toBe("keep.txt");
		expect(() => {
			accessSync(join(fresh, "run.sh"), constants.X_OK);
		}).not.toThrow();
		expect(existsSync(join(fresh, "gone.txt"))).toBe(false);
		expect(existsSync(join(fresh, "debug.log"))).toBe(false);

		// `git stash apply --index` works on W by hand too.
		const byHand = freshCheckout(w, dir);
		sh(byHand, "stash", "apply", "--index", record.stash);
		expect(status(byHand)).toBe(before);
	});

	it("sees no change between two captures of the same tree, and a clean checkout as clean", async () => {
		const w = world();
		const dir = w.clone();
		const clean = await captureState(dir);
		expect(isClean(clean)).toBe(true);
		write(dir, "keep.txt", "x\n");
		const first = await captureState(dir);
		expect(isClean(first)).toBe(false);
		const second = await captureState(dir);
		expect(stateKey(second)).toBe(stateKey(first));
		sh(dir, "add", "keep.txt");
		expect(stateKey(await captureState(dir))).not.toBe(stateKey(first));
	});

	it("keeps local commits that were never pushed, on a branch only the earlier run had", async () => {
		const w = world();
		const dir = w.clone();
		sh(dir, "checkout", "-q", "-b", "pi/feature");
		write(dir, "feature.txt", "committed\n");
		sh(dir, "add", "feature.txt");
		sh(dir, "commit", "-q", "-m", "feat: local only");
		const local = sh(dir, "rev-parse", "HEAD").trim();
		write(dir, "feature.txt", "committed, then edited\n");
		const record = await snapshot(dir);
		const fresh = freshCheckout(w, dir);
		await expect(restoreSnapshot(fresh, record)).resolves.toMatchObject({
			status: "restored",
			branch: "pi/feature",
			head: local,
		});
		expect(read(fresh, "feature.txt")).toBe("committed, then edited\n");
	});

	it("merges the snapshot onto a remote branch that moved ahead", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "keep.txt", "keep, changed\n");
		const record = await snapshot(dir);
		write(w.seed, "other.txt", "someone else\n");
		sh(w.seed, "add", "other.txt");
		sh(w.seed, "commit", "-q", "-m", "other");
		sh(w.seed, "push", "-q", "origin", "main");
		const fresh = freshCheckout(w, dir);
		const outcome = await restoreSnapshot(fresh, record);
		expect(outcome).toMatchObject({
			status: "restored",
			moved: true,
			conflicts: [],
		});
		expect(read(fresh, "keep.txt")).toBe("keep, changed\n");
		expect(read(fresh, "other.txt")).toBe("someone else\n");
	});

	it("leaves conflict markers when the moved branch changed the same lines", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "conflict.txt", "pi's\n");
		const record = await snapshot(dir);
		write(w.seed, "conflict.txt", "theirs\n");
		sh(w.seed, "commit", "-q", "-am", "theirs");
		sh(w.seed, "push", "-q", "origin", "main");
		const fresh = freshCheckout(w, dir);
		const outcome = await restoreSnapshot(fresh, record);
		expect(outcome).toMatchObject({
			status: "restored",
			staged: false,
			conflicts: ["conflict.txt"],
		});
		expect(read(fresh, "conflict.txt")).toContain("<<<<<<<");
	});

	it("reports a diverged branch and leaves the checkout alone", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "x.txt", "pi\n");
		sh(dir, "add", "x.txt");
		sh(dir, "commit", "-q", "-m", "pi's commit");
		write(dir, "keep.txt", "edited\n");
		const record = await snapshot(dir);
		write(w.seed, "y.txt", "them\n");
		sh(w.seed, "add", "y.txt");
		sh(w.seed, "commit", "-q", "-m", "their commit");
		sh(w.seed, "push", "-q", "origin", "main");
		const fresh = freshCheckout(w, dir);
		const head = sh(fresh, "rev-parse", "HEAD").trim();
		await expect(restoreSnapshot(fresh, record)).resolves.toMatchObject({
			status: "diverged",
			branch: "main",
			head: record.head,
			remoteHead: head,
		});
		expect(sh(fresh, "rev-parse", "HEAD").trim()).toBe(head);
		expect(status(fresh)).toBe("");
	});

	it("applies a detached snapshot onto a checkout that contains its HEAD, else on its HEAD", async () => {
		const w = world();
		const dir = w.clone();
		sh(dir, "checkout", "-q", "--detach");
		write(dir, "keep.txt", "detached\n");
		const contained = await snapshot(dir);
		expect(contained.branch).toBeUndefined();
		const onMain = freshCheckout(w, dir);
		await expect(restoreSnapshot(onMain, contained)).resolves.toMatchObject({
			status: "restored",
			branch: "main",
		});
		expect(read(onMain, "keep.txt")).toBe("detached\n");

		sh(dir, "commit", "-q", "-am", "detached commit");
		write(dir, "keep.txt", "detached, again\n");
		const elsewhere = await snapshot(dir);
		const fresh = freshCheckout(w, dir);
		await expect(restoreSnapshot(fresh, elsewhere)).resolves.toMatchObject({
			status: "restored",
			branch: undefined,
			head: elsewhere.head,
		});
		expect(read(fresh, "keep.txt")).toBe("detached, again\n");
	});

	it("starts clean when the restore fails, keeping files that were already there", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "keep.txt", "changed\n");
		write(dir, "untracked.txt", "pi's\n");
		write(dir, "also-untracked.txt", "pi's too\n");
		const record = await snapshot(dir);
		const fresh = freshCheckout(w, dir);
		// A file the snapshot would create is already there: git refuses to overwrite it.
		write(fresh, "untracked.txt", "already here\n");
		const outcome = await restoreSnapshot(fresh, record);
		expect(outcome.status).toBe("failed");
		expect(read(fresh, "keep.txt")).toBe("keep\n");
		expect(read(fresh, "untracked.txt")).toBe("already here\n");
		expect(existsSync(join(fresh, "also-untracked.txt"))).toBe(false);
		expect(status(fresh)).toBe("?? untracked.txt\n");
	});

	it("skips untracked files over the size limits or matching the exclude globs, and records them", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, ".env.local", "SECRET=1\n");
		write(dir, "certs/server.pem", "-----BEGIN-----\n");
		write(dir, "big.dat", Buffer.alloc(2048));
		write(dir, "a.txt", Buffer.alloc(600));
		write(dir, "b.txt", Buffer.alloc(600));
		const record = await snapshot(
			dir,
			{},
			{ maxFileBytes: 1024, maxTotalBytes: 1000, exclude: [".env*", "*.pem"] },
		);
		expect(record.skipped.map((skip) => skip.path).toSorted()).toStrictEqual([
			".env.local",
			"b.txt",
			"big.dat",
			"certs/server.pem",
		]);
		expect(record.skipped.find((s) => s.path === "big.dat")?.reason).toContain(
			"limit for a file",
		);
		expect(record.skipped.find((s) => s.path === "b.txt")?.reason).toContain(
			"limit for a snapshot",
		);
		await expect(readSnapshot(dir, record.wrapper)).resolves.toMatchObject({
			skipped: record.skipped,
		});
		const kept = sh(dir, "ls-tree", "-r", "--name-only", `${record.stash}^3`);
		expect(kept).toBe("a.txt\n");
	});

	it("chains snapshots on one ref, each wrapper on the one before", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "keep.txt", "1\n");
		const first = await snapshot(dir);
		write(dir, "keep.txt", "2\n");
		const second = await snapshot(dir);
		expect(sh(dir, "rev-parse", `${second.wrapper}^1`).trim()).toBe(
			first.wrapper,
		);
		expect(sh(dir, "rev-parse", `${second.wrapper}^2`).trim()).toBe(
			second.stash,
		);
		expect(sh(dir, "show", `${REF}:keep.txt`)).toBe("2\n");
	});
});

describe("isExcluded", () => {
	it.each([
		[".env", true],
		["config/.env.production", true],
		["keys/id_rsa.pub", true],
		["server.key", true],
		["src/env.ts", false],
		["docs/secrets/a.txt", true],
		["secrets/a.txt", false],
	])("%s: %s", (path, excluded) => {
		expect(
			isExcluded(path, [".env*", "*.key", "id_rsa*", "docs/**/a.txt"]),
		).toBe(excluded);
	});
});

describe("uniqueWork", () => {
	it("finds nothing when the newer snapshot only adds work that was pushed", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "keep.txt", "uncommitted\n");
		const target = await snapshot(dir);
		// Later, pi committed and pushed that change.
		sh(dir, "commit", "-q", "-am", "pushed");
		sh(dir, "push", "-q", "origin", "main");
		const latest = await snapshot(dir);
		const fresh = freshCheckout(w, dir);
		await expect(uniqueWork(fresh, latest, target)).resolves.toStrictEqual({
			files: [],
			commits: [],
		});
	});

	it("finds the files and local commits only the newer snapshot has", async () => {
		const w = world();
		const dir = w.clone();
		write(dir, "keep.txt", "older\n");
		const target = await snapshot(dir);
		write(dir, "local.txt", "local\n");
		sh(dir, "add", "local.txt");
		sh(dir, "commit", "-q", "-m", "local");
		const commit = sh(dir, "rev-parse", "HEAD").trim();
		write(dir, "keep.txt", "newer\n");
		write(dir, "fresh.txt", "untracked\n");
		const latest = await snapshot(dir);
		const fresh = freshCheckout(w, dir);
		await expect(uniqueWork(fresh, latest, target)).resolves.toStrictEqual({
			files: ["fresh.txt", "keep.txt"],
			commits: [commit],
		});
		// With no target, a clean checkout is what would be restored.
		await expect(uniqueWork(fresh, latest, undefined)).resolves.toMatchObject({
			files: ["fresh.txt", "keep.txt"],
		});
	});
});
