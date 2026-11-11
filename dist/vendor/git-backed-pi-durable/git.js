// Vendored from github.com/cv/git-backed-pi-durable (1b9ba48). Edit there, then copy.
// Minimal in-process git object store: loose-object writes, ref reads/CAS updates.
// Objects git has packed (after fetch or gc) are read through one long-lived `git cat-file --batch`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
const SHA = /^[0-9a-f]{40}$/;
export const ZERO = "0".repeat(40);
export class RefConflictError extends Error {
    ref;
    expected;
    actual;
    constructor(ref, expected, actual) {
        super(`Ref ${ref} moved: expected ${expected ?? "(none)"}, found ${actual ?? "(none)"}`);
        this.name = "RefConflictError";
        this.ref = ref;
        this.expected = expected;
        this.actual = actual;
    }
}
/** Rough check-ref-format: refs/..., no "..", control chars, spaces, ~^:?*[\\, "@{", ".lock" components. */
export function assertRefName(ref) {
    const bad = !ref.startsWith("refs/") ||
        ref.endsWith("/") ||
        ref.endsWith(".") ||
        ref.includes("..") ||
        ref.includes("//") ||
        ref.includes("@{") ||
        /[\x00-\x20\x7f~^:?*[\\]/.test(ref) ||
        ref.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock"));
    if (bad)
        throw new Error(`Invalid ref name: ${ref}`);
}
export class GitRepo {
    /** Where objects and shared refs live (the common dir for linked worktrees). */
    commonDir;
    fsync;
    catFile;
    constructor(commonDir, fsync) {
        this.commonDir = commonDir;
        this.fsync = fsync;
    }
    /** Open a repository: a work tree, a `.git` dir, a bare repo, or a linked worktree's `.git` file. */
    static async open(path, options = {}) {
        let gitDir = resolve(path);
        const dotGit = join(gitDir, ".git");
        const stat = await fs.stat(dotGit).catch(() => undefined);
        if (stat?.isDirectory())
            gitDir = dotGit;
        else if (stat?.isFile()) {
            const text = await fs.readFile(dotGit, "utf8");
            const match = /^gitdir: (.+)$/m.exec(text);
            if (!match)
                throw new Error(`Malformed .git file in ${path}`);
            gitDir = resolve(gitDir, match[1].trim());
        }
        if (!(await exists(join(gitDir, "HEAD"))))
            throw new Error(`Not a git repository: ${path}`);
        let commonDir = gitDir;
        const common = await fs.readFile(join(gitDir, "commondir"), "utf8").catch(() => undefined);
        if (common !== undefined)
            commonDir = resolve(gitDir, common.trim());
        const config = await fs.readFile(join(commonDir, "config"), "utf8").catch(() => "");
        if (/^\s*refStorage\s*=\s*reftable/im.test(config))
            throw new Error("reftable repositories are not supported");
        if (/^\s*objectFormat\s*=\s*sha256/im.test(config))
            throw new Error("sha256 repositories are not supported");
        return new GitRepo(commonDir, options.fsync ?? false);
    }
    // ---- objects ----
    static hash(type, content) {
        const raw = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
        return { sha: createHash("sha1").update(raw).digest("hex"), raw };
    }
    async writeObject(type, content) {
        const { sha, raw } = GitRepo.hash(type, content);
        const path = this.objectPath(sha);
        if (await exists(path))
            return sha;
        await fs.mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        const handle = await fs.open(tmp, "wx", 0o444);
        try {
            await handle.writeFile(deflateSync(raw));
            if (this.fsync)
                await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.rename(tmp, path).catch(async (error) => {
            await fs.rm(tmp, { force: true });
            if (!(await exists(path)))
                throw error;
        });
        return sha;
    }
    async writeBlob(content) {
        return this.writeObject("blob", Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
    /** A tree of regular files; names are sorted as git requires. */
    async writeTree(files) {
        const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const parts = [];
        for (const name of names) {
            if (!SHA.test(files[name]) || name.includes("/") || name.includes("\0"))
                throw new Error(`Bad tree entry ${name}`);
            parts.push(Buffer.from(`100644 ${name}\0`), Buffer.from(files[name], "hex"));
        }
        return this.writeObject("tree", Buffer.concat(parts));
    }
    async writeCommit(input) {
        const seconds = Math.floor((input.time ?? new Date()).getTime() / 1000);
        const who = `${clean(input.author.name)} <${clean(input.author.email)}> ${seconds} +0000`;
        const lines = [`tree ${input.tree}`, ...input.parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`];
        return this.writeObject("commit", Buffer.from(`${lines.join("\n")}\n\n${input.message}`));
    }
    async readObject(sha) {
        if (!SHA.test(sha))
            throw new Error(`Bad object id ${sha}`);
        const loose = await fs.readFile(this.objectPath(sha)).catch(() => undefined);
        if (loose !== undefined) {
            const raw = inflateSync(loose);
            const nul = raw.indexOf(0);
            const [type, size] = raw.subarray(0, nul).toString().split(" ");
            const content = raw.subarray(nul + 1);
            if (content.length !== Number(size))
                throw new Error(`Corrupt loose object ${sha}`);
            return { type, content };
        }
        this.catFile ??= new CatFile(this.commonDir);
        return this.catFile.read(sha);
    }
    async readCommit(sha) {
        const object = await this.readObject(sha);
        if (object.type !== "commit")
            throw new Error(`${sha} is a ${object.type}, not a commit`);
        const text = object.content.toString("utf8");
        const split = text.indexOf("\n\n");
        const headers = text.slice(0, split === -1 ? text.length : split).split("\n");
        const tree = headers.find((h) => h.startsWith("tree "))?.slice(5);
        if (tree === undefined)
            throw new Error(`Commit ${sha} has no tree`);
        const parents = headers.filter((h) => h.startsWith("parent ")).map((h) => h.slice(7));
        return { tree, parents, message: split === -1 ? "" : text.slice(split + 2) };
    }
    async readTree(sha) {
        const object = await this.readObject(sha);
        if (object.type !== "tree")
            throw new Error(`${sha} is a ${object.type}, not a tree`);
        const entries = {};
        const buf = object.content;
        for (let i = 0; i < buf.length;) {
            const nul = buf.indexOf(0, i);
            const name = buf.subarray(buf.indexOf(32, i) + 1, nul).toString("utf8");
            entries[name] = buf.subarray(nul + 1, nul + 21).toString("hex");
            i = nul + 21;
        }
        return entries;
    }
    // ---- refs ----
    async readRef(ref) {
        assertRefName(ref);
        const loose = await fs.readFile(join(this.commonDir, ref), "utf8").catch(() => undefined);
        if (loose !== undefined) {
            const value = loose.trim();
            if (!SHA.test(value))
                throw new Error(`Ref ${ref} is not a direct ref`);
            return value;
        }
        const packed = await fs.readFile(join(this.commonDir, "packed-refs"), "utf8").catch(() => "");
        for (const line of packed.split("\n")) {
            if (line.length > 41 && line[40] === " " && line.slice(41) === ref)
                return line.slice(0, 40);
        }
        return undefined;
    }
    /**
     * Compare-and-swap `ref` from `expected` (undefined: must not exist) to `value`, with git's own lock-file
     * protocol, so a concurrent `git update-ref`, fetch, or another GitStorage sees one winner.
     */
    async updateRef(ref, value, expected, reflogMessage) {
        assertRefName(ref);
        if (!SHA.test(value))
            throw new Error(`Bad object id ${value}`);
        const path = join(this.commonDir, ref);
        const lock = `${path}.lock`;
        await fs.mkdir(dirname(path), { recursive: true });
        let handle;
        try {
            handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        }
        catch (error) {
            if (error?.code === "EEXIST")
                throw new RefConflictError(ref, expected, "(locked)");
            throw error;
        }
        let renamed = false;
        try {
            const actual = await this.readRef(ref);
            if (actual !== expected)
                throw new RefConflictError(ref, expected, actual);
            await handle.writeFile(`${value}\n`);
            if (this.fsync)
                await handle.sync();
            await handle.close();
            await fs.rename(lock, path);
            renamed = true;
            if (reflogMessage !== undefined)
                await this.appendReflog(ref, expected ?? ZERO, value, reflogMessage);
        }
        finally {
            if (!renamed) {
                await handle.close().catch(() => { });
                await fs.rm(lock, { force: true });
            }
        }
    }
    async appendReflog(ref, from, to, message) {
        const path = join(this.commonDir, "logs", ref);
        await fs.mkdir(dirname(path), { recursive: true });
        const seconds = Math.floor(Date.now() / 1000);
        await fs.appendFile(path, `${from} ${to} pi-durable <pi-durable@localhost> ${seconds} +0000\t${clean(message)}\n`);
    }
    async close() {
        await this.catFile?.close();
        this.catFile = undefined;
    }
    objectPath(sha) {
        return join(this.commonDir, "objects", sha.slice(0, 2), sha.slice(2));
    }
}
/** One `git cat-file --batch` process answering reads in order. */
class CatFile {
    child;
    buffer = Buffer.alloc(0);
    waiting = [];
    failure;
    constructor(gitDir) {
        this.child = spawn("git", ["--git-dir", gitDir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdout.on("data", (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.drain();
        });
        const fail = (error) => {
            this.failure ??= error;
            for (const w of this.waiting.splice(0))
                w.reject(this.failure);
        };
        this.child.on("error", fail);
        this.child.on("exit", (code) => fail(new Error(`git cat-file exited with ${code}`)));
        this.child.stdin.on("error", fail);
    }
    read(sha) {
        if (this.failure)
            return Promise.reject(this.failure);
        return new Promise((resolve, reject) => {
            this.waiting.push({ sha, resolve, reject });
            this.child.stdin.write(`${sha}\n`);
        });
    }
    drain() {
        while (this.waiting.length > 0) {
            const eol = this.buffer.indexOf(10);
            if (eol === -1)
                return;
            const header = this.buffer.subarray(0, eol).toString();
            const current = this.waiting[0];
            if (header.endsWith(" missing")) {
                this.buffer = this.buffer.subarray(eol + 1);
                this.waiting.shift();
                current.reject(new Error(`Object ${current.sha} is missing`));
                continue;
            }
            const [, type, size] = header.split(" ");
            const end = eol + 1 + Number(size);
            if (this.buffer.length < end + 1)
                return;
            const content = Buffer.from(this.buffer.subarray(eol + 1, end));
            this.buffer = this.buffer.subarray(end + 1);
            this.waiting.shift();
            current.resolve({ type, content });
        }
    }
    async close() {
        if (this.child.exitCode !== null)
            return;
        const exited = new Promise((r) => this.child.once("exit", r));
        this.child.stdin.end();
        await exited;
    }
}
async function exists(path) {
    return fs.access(path).then(() => true, () => false);
}
function clean(text) {
    return text.replace(/[<>\n\0]/g, "");
}
