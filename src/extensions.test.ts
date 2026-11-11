import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import {
	classifySpec,
	createExtensionApi,
	type ExtensionProvider,
	findDurableEntry,
	findExtensionEntries,
	hostAliases,
	loadExtensions,
	type NpmRunner,
} from "./extensions.ts";
import type { Logger } from "./run.ts";
import { createLogger, tempDir } from "./test-helpers.ts";

const FIXTURE = resolve("test/fixtures/extensions/echo-provider");
const NOT_SPEC = /not an npm package spec/u;
const GIT_HINT = /github:owner\/repo#ref/u;
const NOT_FOUND = /Extension \S+ not found/u;
const NO_DEFAULT = /has no default export function/u;
const COULD_NOT_LOAD = /Could not load pi extension .*boom/u;
const NPM_FAILED = /npm could not install nope@9: E404 not found/u;
const BAD_REGISTER = /takes a provider name and config/u;
const NO_FACTORY = /exports no createPiDurableExtension function/u;
const NOT_DURABLE = /did not return a pi-durable extension/u;
const BAD_DURABLE = /pi\.durable in package\.json must be a module path/u;
const MISSING_DURABLE = /pi\.durable entry \.\/gone\.ts not found/u;
const DURABLE_FIXTURE = "./test/fixtures/extensions/durable-ask";
const HOST = {
	cwd: "/w",
	agentDir: "/a",
	trustProject: false,
	log: createLogger(),
};

function write(path: string, content: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

type Fn = (...args: unknown[]) => unknown;

const byPath = (a: string, b: string): number => a.localeCompare(b);

const warnings = (log: Logger): string[] =>
	vi.mocked(log.warning).mock.calls.map(([msg]) => msg);

describe("classifySpec", () => {
	it("resolves paths against the workspace and keeps npm specs", () => {
		expect(classifySpec("./ext", "/work")).toStrictEqual({
			kind: "path",
			path: "/work/ext",
		});
		expect(classifySpec("../ext", "/work/repo")).toStrictEqual({
			kind: "path",
			path: "/work/ext",
		});
		expect(classifySpec("/abs/ext.ts", "/work")).toStrictEqual({
			kind: "path",
			path: "/abs/ext.ts",
		});
		expect(classifySpec("~/ext", "/work")).toStrictEqual({
			kind: "path",
			path: join(homedir(), "ext"),
		});
		expect(classifySpec("npm:@acme/pi-bar@^2", "/work")).toStrictEqual({
			kind: "npm",
			spec: "@acme/pi-bar@^2",
		});
		expect(classifySpec("github:acme/pi-bar#v1", "/work")).toStrictEqual({
			kind: "npm",
			spec: "github:acme/pi-bar#v1",
		});
	});

	it("rejects options, whitespace, and pi's git: sources", () => {
		expect(() => classifySpec("--registry=evil", "/w")).toThrow(NOT_SPEC);
		expect(() => classifySpec("npm:", "/w")).toThrow(NOT_SPEC);
		expect(() => classifySpec("a b", "/w")).toThrow(NOT_SPEC);
		expect(() => classifySpec("git:github.com/a/b@v1", "/w")).toThrow(GIT_HINT);
	});
});

describe("findExtensionEntries", () => {
	it("follows a pi.extensions manifest with globs, exclusions, and directories", () => {
		const dir = tempDir();
		write(
			join(dir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						"./src/main.ts",
						"./plugins/*.ts",
						"!./plugins/legacy.ts",
						"./nested",
						"./missing.ts",
					],
				},
			}),
		);
		const main = write(join(dir, "src/main.ts"), "");
		const a = write(join(dir, "plugins/a.ts"), "");
		write(join(dir, "plugins/legacy.ts"), "");
		const nested = write(join(dir, "nested/index.js"), "");
		expect(findExtensionEntries(dir).toSorted(byPath)).toStrictEqual(
			[main, a, nested].toSorted(byPath),
		);
	});

	it("discovers the extensions/ directory one level deep", () => {
		const dir = tempDir();
		write(join(dir, "package.json"), JSON.stringify({ name: "x", pi: {} }));
		const file = write(join(dir, "extensions/one.ts"), "");
		const sub = write(join(dir, "extensions/two/index.ts"), "");
		write(join(dir, "extensions/README.md"), "");
		write(join(dir, "extensions/.hidden.ts"), "");
		write(join(dir, "extensions/node_modules/dep/index.js"), "");
		write(join(dir, "extensions/empty/notes.txt"), "");
		expect(findExtensionEntries(dir).toSorted(byPath)).toStrictEqual(
			[file, sub].toSorted(byPath),
		);
	});

	it("falls back to index.ts or index.js, and takes files as they are", () => {
		const dir = tempDir();
		const index = write(join(dir, "index.js"), "");
		expect(findExtensionEntries(dir)).toStrictEqual([index]);
		expect(findExtensionEntries(index)).toStrictEqual([index]);
		expect(findExtensionEntries(join(dir, "nope"))).toStrictEqual([]);
		expect(findExtensionEntries(tempDir())).toStrictEqual([]);
	});
});

describe("createExtensionApi", () => {
	it("keeps providers and warns once about each unsupported feature", () => {
		const providers: ExtensionProvider[] = [];
		const log = createLogger();
		const pi = createExtensionApi("ext.ts", providers, log);
		const call = (name: string, ...args: unknown[]): unknown =>
			Reflect.apply(Reflect.get(pi, name) as Fn, pi, args);
		call("registerTool", { name: "t" });
		call("registerTool", { name: "u" });
		call("registerCommand", "c", {});
		call("registerProvider", "acme", {
			baseUrl: "https://acme.invalid",
			api: "openai-completions",
			models: [{ id: "m" }],
			oauth: { name: "Acme" },
		});
		call("registerProvider", "other", { baseUrl: "https://o.invalid" });
		call("unregisterProvider", "other");
		const events = Reflect.get(pi, "events") as { on: Fn; emit: Fn };
		const off = events.on("x", vi.fn());
		events.emit("x", {});

		expect(off).toBeTypeOf("function");
		expect(Reflect.get(pi, "then")).toBeUndefined();
		expect(Reflect.get(pi, Symbol.iterator)).toBeUndefined();
		expect(providers.map((p) => [p.id, p.kind, p.source])).toStrictEqual([
			["acme", "config", "ext.ts"],
		]);
		expect(warnings(log)).toStrictEqual([
			"ext.ts: pi.registerTool() is not supported by pi-action (only providers are); ignored",
			"ext.ts: pi.registerCommand() is not supported by pi-action (only providers are); ignored",
			"ext.ts: provider acme: oauth not supported by pi-action; ignored",
		]);
		expect(() => call("registerProvider", 42)).toThrow(BAD_REGISTER);
	});
});

describe("loadExtensions", () => {
	it("does nothing without extensions", async () => {
		const runNpm = vi.fn<NpmRunner>();
		await expect(
			loadExtensions({
				specs: [],
				cwd: tempDir(),
				log: createLogger(),
				runNpm,
			}),
		).resolves.toStrictEqual({ providers: [], durable: [] });
		expect(runNpm).not.toHaveBeenCalled();
	});

	it("loads a TypeScript extension from a workspace path", async () => {
		const log = createLogger();
		const { providers } = await loadExtensions({
			specs: ["./test/fixtures/extensions/echo-provider"],
			cwd: process.cwd(),
			log,
		});
		expect(providers).toHaveLength(1);
		expect(providers[0]).toMatchObject({
			id: "echo",
			kind: "config",
			source: "test/fixtures/extensions/echo-provider/index.ts",
		});
		expect(log.info).toHaveBeenCalledWith(
			"Loaded pi extension test/fixtures/extensions/echo-provider/index.ts: provider echo",
		);
		expect(warnings(log)).toStrictEqual([
			"test/fixtures/extensions/echo-provider/index.ts: pi.registerTool() is not supported by pi-action (only providers are); ignored",
			"test/fixtures/extensions/echo-provider/index.ts: pi.on() is not supported by pi-action (only providers are); ignored",
		]);
	});

	it("installs an npm package into RUNNER_TEMP, without lifecycle scripts, and loads it", async () => {
		const packs = tempDir();
		execFileSync(
			"npm",
			["pack", "--silent", "--pack-destination", packs, FIXTURE],
			{
				stdio: "ignore",
			},
		);
		const [tarball = ""] = readdirSync(packs);
		const runnerTemp = tempDir();
		const workspace = tempDir();
		const log = createLogger();

		const { providers } = await loadExtensions({
			specs: [`npm:file:${join(packs, tarball)}`],
			cwd: workspace,
			log,
			env: { ...process.env, RUNNER_TEMP: runnerTemp, INPUT_GITHUB_TOKEN: "x" },
		});

		expect(providers.map((p) => p.id)).toStrictEqual(["echo"]);
		expect(readdirSync(workspace)).toStrictEqual([]); // the repository is untouched
		const [installDir = ""] = readdirSync(runnerTemp);
		const installed = join(
			runnerTemp,
			installDir,
			"node_modules",
			"pi-action-echo-provider",
		);
		expect(existsSync(join(installed, "index.ts"))).toBe(true);
		expect(existsSync(join(installed, "postinstall-ran"))).toBe(false);
		expect(log.info).toHaveBeenCalledWith(
			`Installing pi extensions: file:${join(packs, tarball)}`,
		);
	}, 120_000);

	it("passes npm the safe flags and a scrubbed environment", async () => {
		const runNpm = vi.fn<NpmRunner>(async (_args, cwd) => {
			write(
				join(cwd, "package.json"),
				JSON.stringify({ dependencies: { "@acme/helper": "1.0.0" } }),
			);
			write(join(cwd, "node_modules/@acme/helper/lib.js"), "");
		});
		const log = createLogger();
		await expect(
			loadExtensions({
				specs: ["@acme/helper@1"],
				cwd: tempDir(),
				log,
				env: { RUNNER_TEMP: tempDir(), INPUT_API_KEY: "secret", PATH: "/bin" },
				runNpm,
			}),
		).resolves.toStrictEqual({ providers: [], durable: [] });
		const [call] = runNpm.mock.calls;
		expect(call?.[0]).toStrictEqual(
			expect.arrayContaining([
				"install",
				"--ignore-scripts",
				"--legacy-peer-deps",
				"--omit=dev",
				"@acme/helper@1",
			]),
		);
		expect(call?.[2]).toStrictEqual({
			RUNNER_TEMP: expect.any(String),
			PATH: "/bin",
		});
		expect(warnings(log)).toStrictEqual([
			"@acme/helper has no pi extensions; it is installed for other extensions to import",
		]);
	});

	it("reports npm failures with npm's message", async () => {
		const runNpm: NpmRunner = async () => {
			throw new Error("E404 not found");
		};
		const runnerTemp = join(tempDir(), "missing-yet");
		await expect(
			loadExtensions({
				specs: ["nope@9"],
				cwd: tempDir(),
				log: createLogger(),
				env: { RUNNER_TEMP: runnerTemp },
				runNpm,
			}),
		).rejects.toThrow(NPM_FAILED);
	});

	it("fails clearly for missing paths, non-extensions, and throwing factories", async () => {
		const cwd = tempDir();
		write(join(cwd, "not-a-factory.ts"), "export default 42;\n");
		write(
			join(cwd, "throws.ts"),
			"export default () => { throw new Error('boom'); };\n",
		);
		const load = async (spec: string) =>
			loadExtensions({ specs: [spec], cwd, log: createLogger() });
		await expect(load("./missing")).rejects.toThrow(NOT_FOUND);
		await expect(load("./not-a-factory.ts")).rejects.toThrow(NO_DEFAULT);
		await expect(load("./throws.ts")).rejects.toThrow(COULD_NOT_LOAD);
	});

	it("maps pi-ai imports, subpaths, and legacy names to the action's copy", async () => {
		const cwd = tempDir();
		write(
			join(cwd, "ext/index.ts"),
			[
				'import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";',
				'import { createModels } from "@mariozechner/pi-ai/models";',
				'import { getApiProvider } from "@earendil-works/pi-ai";',
				"export default async function (pi: { registerProvider(p: unknown): void }): Promise<void> {",
				"\tif (!getApiProvider('openai-completions') || !createModels) throw new Error('no compat');",
				"\tpi.registerProvider(fauxProvider({ provider: 'native' }).provider);",
				"}",
			].join("\n"),
		);
		const { providers } = await loadExtensions({
			specs: ["./ext"],
			cwd,
			log: createLogger(),
		});
		expect(providers.map((p) => [p.id, p.kind])).toStrictEqual([
			["native", "provider"],
		]);
	});
});

describe("loadExtensions: pi-durable extension packages", () => {
	it("loads only the pi.durable entry of a package that also has pi extensions", async () => {
		const log = createLogger();
		const loaded = await loadExtensions({
			specs: [DURABLE_FIXTURE],
			cwd: process.cwd(),
			log,
		});
		expect(loaded.providers).toStrictEqual([]);
		expect(loaded.durable.map((d) => d.source)).toStrictEqual([
			"test/fixtures/extensions/durable-ask/durable.ts",
		]);
		expect(log.info).toHaveBeenCalledWith(
			`${resolve(DURABLE_FIXTURE)} has a pi-durable extension (pi.durable) and pi extensions (pi.extensions); loading only the pi-durable one, as the others need pi's coding agent`,
		);
		expect(log.info).toHaveBeenCalledWith(
			"Loaded pi-durable extension test/fixtures/extensions/durable-ask/durable.ts",
		);
		const extension = await loaded.durable[0]?.create(HOST);
		expect(extension?.name).toBe("durable-ask");
		expect(extension?.tools?.map((t) => t.name)).toStrictEqual(["ask_user"]);
		expect(HOST.log.info).toHaveBeenCalledWith(
			"durable-ask: trustProject=false",
		);
	});

	it("takes a default export, and shares the host's pi-durable and chord", async () => {
		const cwd = tempDir(); // outside the repository: only the aliases can resolve these imports
		write(
			join(cwd, "ext/package.json"),
			JSON.stringify({ pi: { durable: "./main.ts" } }),
		);
		write(
			join(cwd, "ext/main.ts"),
			[
				'import { createRegistry } from "@earendil-works/pi-durable";',
				'import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";',
				"export default (options: { cwd: string }) => ({ name: options.cwd, sections: [], createRegistry, BACKGROUND_CONTEXT });",
			].join("\n"),
		);
		const { durable } = await loadExtensions({
			specs: ["./ext"],
			cwd,
			log: createLogger(),
		});
		const extension = await durable[0]?.create(HOST);
		expect(extension?.name).toBe("/w");
		expect(extension).toHaveProperty("createRegistry", createRegistry);
		expect(extension).toHaveProperty("BACKGROUND_CONTEXT", BACKGROUND_CONTEXT);
	});

	it("fails clearly for bad pi.durable entries and factories", async () => {
		const cwd = tempDir();
		const pkg = (dir: string, durable: unknown, code = "") => {
			write(
				join(cwd, dir, "package.json"),
				JSON.stringify({ pi: { durable } }),
			);
			write(join(cwd, dir, "main.ts"), code);
		};
		pkg("none", "./main.ts", "export const other = 1;\n");
		pkg(
			"bad-result",
			"./main.ts",
			"export function createPiDurableExtension() { return { tools: 1 }; }\n",
		);
		pkg("not-a-path", 42);
		pkg("gone", "./gone.ts");
		const load = async (spec: string) =>
			loadExtensions({ specs: [spec], cwd, log: createLogger() });
		await expect(load("./none")).rejects.toThrow(NO_FACTORY);
		await expect(load("./not-a-path")).rejects.toThrow(BAD_DURABLE);
		await expect(load("./gone")).rejects.toThrow(MISSING_DURABLE);
		const { durable } = await load("./bad-result");
		await expect(durable[0]?.create(HOST)).rejects.toThrow(NOT_DURABLE);
		expect(findDurableEntry(join(cwd, "none", "main.ts"))).toBeUndefined();
	});

	it("aliases pi-durable and chord, with their subpaths", () => {
		const aliases = hostAliases();
		expect(Object.keys(aliases)).toStrictEqual(
			expect.arrayContaining([
				"@earendil-works/pi-ai",
				"@mariozechner/pi-ai/models",
				"@earendil-works/pi-durable",
				"@earendil-works/pi-durable/tools",
				"@earendil-works/chord",
				"@earendil-works/chord/context",
			]),
		);
		expect(aliases["@earendil-works/pi-durable"]).toBe(
			fileURLToPath(import.meta.resolve("@earendil-works/pi-durable")),
		);
	});
});
