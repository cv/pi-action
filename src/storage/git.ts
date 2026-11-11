// The git side of GitStorage. Objects are hashed and written as loose objects in-process (a step is one blob,
// one tree, and one commit, so spawning git for each would cost more than the write). Everything else goes through
// git: the object directory and hash come from rev-parse, the ref moves with update-ref's compare-and-swap, and reads
// are one rev-list plus one long-lived `git cat-file --batch`. So any repository git can open works, SHA-256 and
// reftable included.
import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

interface GitObject {
	readonly type: string;
	readonly content: Buffer;
}
export interface Signature {
	readonly name: string;
	readonly email: string;
}
export interface ChainCommit {
	readonly id: string;
	readonly parents: readonly string[];
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BAD_TREE_NAME = /[/\0]/u;
const IDENT_CRUD = /[<>\n\0]/gu;

export class RefConflictError extends Error {
	readonly ref: string;
	readonly expected: string | undefined;
	readonly actual: string | undefined;
	constructor(
		ref: string,
		expected: string | undefined,
		actual: string | undefined,
		options?: { cause?: unknown },
	) {
		super(
			`Ref ${ref} moved: expected ${expected ?? "(none)"}, found ${actual ?? "(none)"}`,
			options,
		);
		this.name = "RefConflictError";
		this.ref = ref;
		this.expected = expected;
		this.actual = actual;
	}
}

/** Control characters, space, and the characters check-ref-format forbids anywhere. */
function hasForbiddenChar(ref: string): boolean {
	for (const ch of ref) {
		const code = ch.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(ch)) {
			return true;
		}
	}
	return false;
}

/** Rough check-ref-format: refs/..., no "..", control chars, spaces, ~^:?*[\\, "@{", ".lock" components. */
export function assertRefName(ref: string): void {
	const bad =
		!ref.startsWith("refs/") ||
		ref.endsWith("/") ||
		ref.endsWith(".") ||
		ref.includes("..") ||
		ref.includes("//") ||
		ref.includes("@{") ||
		hasForbiddenChar(ref) ||
		ref
			.split("/")
			.some(
				(part) => part === "" || part.startsWith(".") || part.endsWith(".lock"),
			);
	if (bad) {
		throw new Error(`Invalid ref name: ${ref}`);
	}
}

class GitError extends Error {
	constructor(args: readonly string[], stderr: string) {
		super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
		this.name = "GitError";
	}
}

/** Run git in `dir`; resolves with stdout, rejects with a GitError on a nonzero exit. */
function git(dir: string, args: readonly string[]): Promise<string> {
	return new Promise((onOutput, onError) => {
		execFile("git", ["-C", dir, ...args], (error, stdout, stderr) => {
			if (error) {
				onError(new GitError(args, stderr || error.message));
			} else {
				onOutput(stdout);
			}
		});
	});
}

function assertObjectId(id: string): void {
	if (!OBJECT_ID.test(id)) {
		throw new Error(`Bad object id ${id}`);
	}
}

export class GitRepo {
	/** The path git runs in (`git -C`): a work tree, a git dir, a bare repo, or a linked worktree. */
	readonly dir: string;
	private readonly objects: string;
	private readonly hash: "sha1" | "sha256";
	private catFile: CatFile | undefined;

	private constructor(dir: string, objects: string, hash: "sha1" | "sha256") {
		this.dir = dir;
		this.objects = objects;
		this.hash = hash;
	}

	static async open(path: string): Promise<GitRepo> {
		const out = await git(path, [
			"rev-parse",
			"--show-object-format",
			"--git-path",
			"objects",
		]).catch((error: unknown) => {
			throw new Error(`Not a git repository: ${path}`, { cause: error });
		});
		const [format = "", objects = ""] = out.trim().split("\n");
		return new GitRepo(
			path,
			resolve(path, objects),
			format === "sha256" ? "sha256" : "sha1",
		);
	}

	/** Write a loose object (unless it exists) and return its id. */
	private async writeObject(
		type: "blob" | "tree" | "commit",
		content: Buffer,
	): Promise<string> {
		const raw = Buffer.concat([
			Buffer.from(`${type} ${content.length}\0`),
			content,
		]);
		const id = createHash(this.hash).update(raw).digest("hex");
		const path = join(this.objects, id.slice(0, 2), id.slice(2));
		const present = await fs.access(path).then(
			() => true,
			() => false,
		);
		if (!present) {
			await fs.mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			await fs.writeFile(tmp, deflateSync(raw), { mode: 0o444 });
			await fs.rename(tmp, path);
		}
		return id;
	}

	writeBlob(content: string): Promise<string> {
		return this.writeObject("blob", Buffer.from(content));
	}

	/** A tree of regular files; names are sorted as git requires. */
	writeTree(files: Readonly<Record<string, string>>): Promise<string> {
		const names = Object.keys(files).sort((a, b) =>
			Buffer.compare(Buffer.from(a), Buffer.from(b)),
		);
		const parts: Buffer[] = [];
		for (const name of names) {
			const id = files[name] ?? "";
			if (!OBJECT_ID.test(id) || BAD_TREE_NAME.test(name)) {
				return Promise.reject(new Error(`Bad tree entry ${name}`));
			}
			parts.push(Buffer.from(`100644 ${name}\0`), Buffer.from(id, "hex"));
		}
		return this.writeObject("tree", Buffer.concat(parts));
	}

	writeCommit(input: {
		tree: string;
		parents: readonly string[];
		author: Signature;
		message: string;
		time?: Date;
	}): Promise<string> {
		const seconds = Math.floor((input.time ?? new Date()).getTime() / 1000);
		const clean = (text: string) => text.replace(IDENT_CRUD, "");
		const who = `${clean(input.author.name)} <${clean(input.author.email)}> ${seconds} +0000`;
		const lines = [
			`tree ${input.tree}`,
			...input.parents.map((p) => `parent ${p}`),
			`author ${who}`,
			`committer ${who}`,
		];
		return this.writeObject(
			"commit",
			Buffer.from(`${lines.join("\n")}\n\n${input.message}`),
		);
	}

	/** Every commit reachable from `tip`, oldest first, with its parents. */
	async commits(tip: string): Promise<ChainCommit[]> {
		assertObjectId(tip);
		const out = await git(this.dir, [
			"rev-list",
			"--reverse",
			"--parents",
			tip,
		]);
		return out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [id = "", ...parents] = line.split(" ");
				return { id, parents };
			});
	}

	/** A file in a commit's tree (`<commit>:<path>`); rejects when it is missing. */
	async readFile(commit: string, path: string): Promise<Buffer> {
		assertObjectId(commit);
		this.catFile ??= new CatFile(this.dir);
		const object = await this.catFile.read(`${commit}:${path}`);
		if (object.type !== "blob") {
			throw new Error(`${commit}:${path} is a ${object.type}, not a file`);
		}
		return object.content;
	}

	/** The commit `ref` points at; undefined when it doesn't exist. */
	async readRef(ref: string): Promise<string | undefined> {
		assertRefName(ref);
		const symbolic = await git(this.dir, ["symbolic-ref", "-q", ref]).then(
			() => true,
			() => false,
		);
		if (symbolic) {
			throw new Error(`Ref ${ref} is not a direct ref`);
		}
		const id = await git(this.dir, ["rev-parse", "-q", "--verify", ref]).catch(
			() => undefined,
		);
		return id?.trim() || undefined;
	}

	/**
	 * Compare-and-swap `ref` from `expected` (undefined: must not exist) to `value`. git update-ref takes the ref's
	 * lock, so a concurrent fetch, update-ref, or another GitStorage sees one winner; losing throws RefConflictError.
	 */
	async updateRef(
		ref: string,
		value: string,
		expected: string | undefined,
		reflogMessage?: string,
	): Promise<void> {
		assertRefName(ref);
		assertObjectId(value);
		const args = ["update-ref"];
		if (reflogMessage !== undefined) {
			args.push("--create-reflog", "-m", reflogMessage);
		}
		try {
			// An empty old value means "must not exist yet".
			await git(this.dir, [...args, ref, value, expected ?? ""]);
		} catch (error) {
			if (!(error instanceof GitError)) {
				throw error;
			}
			const actual = await this.readRef(ref).catch(() => undefined);
			// biome-ignore lint/style/useErrorCause: the cause is passed in the options argument
			throw new RefConflictError(
				ref,
				expected,
				actual === expected ? "(locked)" : actual,
				{ cause: error },
			);
		}
	}

	async close(): Promise<void> {
		await this.catFile?.close();
		this.catFile = undefined;
	}
}

interface Waiting {
	sha: string;
	resolve: (o: GitObject) => void;
	reject: (e: Error) => void;
}

/** One `git cat-file --batch` process answering reads in order. */
class CatFile {
	private readonly child: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private readonly waiting: Waiting[] = [];
	private failure: Error | undefined;

	constructor(dir: string) {
		this.child = spawn("git", ["-C", dir, "cat-file", "--batch"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.drain();
		});
		const fail = (error: Error) => {
			this.failure ??= error;
			for (const w of this.waiting.splice(0)) {
				w.reject(this.failure);
			}
		};
		this.child.on("error", fail);
		this.child.on("exit", (code) =>
			fail(new Error(`git cat-file exited with ${code}`)),
		);
		this.child.stdin.on("error", fail);
	}

	read(sha: string): Promise<GitObject> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		return new Promise((onObject, onError) => {
			this.waiting.push({ sha, resolve: onObject, reject: onError });
			this.child.stdin.write(`${sha}\n`);
		});
	}

	private drain(): void {
		while (this.waiting.length > 0) {
			const eol = this.buffer.indexOf(10);
			if (eol === -1) {
				return;
			}
			const header = this.buffer.subarray(0, eol).toString();
			const [current] = this.waiting;
			if (!current) {
				return;
			}
			if (header.endsWith(" missing")) {
				this.buffer = this.buffer.subarray(eol + 1);
				this.waiting.shift();
				current.reject(new Error(`${current.sha} is missing`));
			} else if (!this.take(header, eol, current)) {
				return;
			}
		}
	}

	/** Hand the object whose header was read to `current`; false while its content hasn't fully arrived. */
	private take(header: string, eol: number, current: Waiting): boolean {
		const [, type, size] = header.split(" ");
		const end = eol + 1 + Number(size);
		if (this.buffer.length < end + 1) {
			return false;
		}
		const content = Buffer.from(this.buffer.subarray(eol + 1, end));
		this.buffer = this.buffer.subarray(end + 1);
		this.waiting.shift();
		current.resolve({ type: type ?? "", content });
		return true;
	}

	async close(): Promise<void> {
		if (this.child.exitCode !== null) {
			return;
		}
		const exited = new Promise((r) => this.child.once("exit", r));
		this.child.stdin.end();
		await exited;
	}
}
