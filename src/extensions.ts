import { execFile } from "node:child_process";
import {
	existsSync,
	globSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Provider } from "@earendil-works/pi-ai/models";
import { createJiti } from "jiti";

import {
	type ExtensionProviderConfig,
	parseProviderConfig,
} from "./extension-provider.ts";
import { field, getErrorMessage, isRecord } from "./utils.ts";

type Env = Record<string, string | undefined>;

interface ExtensionLog {
	info: (msg: string) => void;
	warning: (msg: string) => void;
}

/** A provider an extension registered, applied over the built-in providers in registration order. */
export type ExtensionProvider = { id: string; source: string } & (
	| { kind: "provider"; provider: Provider }
	| { kind: "config"; config: ExtensionProviderConfig }
);

/** Runs npm with these arguments in `cwd`. */
export type NpmRunner = (
	args: string[],
	cwd: string,
	env: Env,
) => Promise<void>;

export interface LoadExtensionsOptions {
	/** The `extensions` input: npm package specs, or paths relative to `cwd`. */
	specs: readonly string[];
	/** The workspace (the checked-out repository). */
	cwd: string;
	log: ExtensionLog;
	env?: Env;
	runNpm?: NpmRunner;
}

const EXTENSION_FILE = /\.(?:[cm]?ts|[cm]?js)$/u;
const GLOB_CHARS = /[*?[{]/u;
const LOCAL_PATH = /^(?:\.{1,2}(?:[/\\]|$)|[/\\]|~[/\\])/u;
const WHITESPACE = /\s/u;
const NPM_PREFIX = "npm:";
const NPM_MAX_BUFFER = 16 * 1024 * 1024;
/** Packages pi provides to extensions; pi-action maps the ones it has to its own copies. */
const HOST_PACKAGES = ["@earendil-works/pi-ai", "@mariozechner/pi-ai"];
const PI_AI = "@earendil-works/pi-ai";

type Source = { kind: "path"; path: string } | { kind: "npm"; spec: string };

export function classifySpec(spec: string, cwd: string): Source {
	if (LOCAL_PATH.test(spec)) {
		const path = spec.startsWith("~") ? join(homedir(), spec.slice(1)) : spec;
		return { kind: "path", path: resolve(cwd, path) };
	}
	const npmSpec = spec.startsWith(NPM_PREFIX)
		? spec.slice(NPM_PREFIX.length)
		: spec;
	if (spec.startsWith("git:")) {
		throw new Error(
			`Extension "${spec}": use an npm git spec instead, such as github:owner/repo#ref`,
		);
	}
	if (!npmSpec || npmSpec.startsWith("-") || WHITESPACE.test(npmSpec)) {
		throw new Error(`Extension "${spec}" is not an npm package spec or a path`);
	}
	return { kind: "npm", spec: npmSpec };
}

/** Runs npm; a failure carries npm's stderr as its message. */
const defaultRunNpm: NpmRunner = async (args, cwd, env) => {
	const {
		promise,
		resolve: done,
		reject: fail,
	} = Promise.withResolvers<undefined>();
	execFile(
		"npm",
		args,
		{ cwd, env, maxBuffer: NPM_MAX_BUFFER },
		(error, _stdout, stderr) => {
			if (error) {
				fail(new Error(stderr.trim() || error.message, { cause: error }));
			} else {
				done(undefined);
			}
		},
	);
	return promise;
};

/** npm's environment without the action's inputs (the GitHub token and api_key). */
function npmEnv(env: Env): Env {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !name.startsWith("INPUT_")),
	);
}

/** Installs npm specs into a fresh directory under RUNNER_TEMP; returns each installed package's root. */
async function installPackages(
	specs: string[],
	env: Env,
	runNpm: NpmRunner,
): Promise<{ name: string; path: string }[]> {
	const base = env["RUNNER_TEMP"] || tmpdir();
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(join(base, "pi-action-extensions-"));
	await writeFile(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "pi-action-extensions", private: true })}\n`,
	);
	try {
		await runNpm(
			[
				"install",
				"--ignore-scripts",
				"--legacy-peer-deps",
				"--omit=dev",
				"--no-audit",
				"--no-fund",
				"--prefix",
				dir,
				...specs,
			],
			dir,
			npmEnv(env),
		);
	} catch (error) {
		throw new Error(
			`npm could not install ${specs.join(", ")}: ${getErrorMessage(error)}`,
			{ cause: error },
		);
	}
	const manifest: unknown = JSON.parse(
		readFileSync(join(dir, "package.json"), "utf8"),
	);
	const installed = field(manifest, "dependencies");
	const dependencies = isRecord(installed) ? Object.keys(installed) : [];
	return dependencies.map((name) => ({
		name,
		path: join(dir, "node_modules", name),
	}));
}

function readPiExtensions(dir: string): string[] | undefined {
	const path = join(dir, "package.json");
	if (!existsSync(path)) {
		return undefined;
	}
	const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
	const extensions = field(field(manifest, "pi"), "extensions");
	return Array.isArray(extensions)
		? extensions.filter((entry) => typeof entry === "string")
		: undefined;
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

/** pi's `pi.extensions` manifest entries: paths and globs, with `!` globs excluding matches. */
function manifestEntries(dir: string, entries: string[]): string[] {
	const excluded = new Set(
		entries
			.filter((entry) => entry.startsWith("!"))
			.flatMap((entry) => globSync(entry.slice(1), { cwd: dir }))
			.map((path) => resolve(dir, path)),
	);
	return entries
		.filter((entry) => !entry.startsWith("!"))
		.flatMap((entry) =>
			GLOB_CHARS.test(entry)
				? globSync(entry, { cwd: dir }).map((path) => resolve(dir, path))
				: [resolve(dir, entry)],
		)
		.filter((path) => !excluded.has(path) && existsSync(path))
		.flatMap((path) =>
			isDirectory(path) ? (directoryEntry(path) ?? []) : [path],
		);
}

/** A directory's declared entries (`pi.extensions`) or its index.ts / index.js. */
function directoryEntry(dir: string): string[] | undefined {
	const declared = readPiExtensions(dir);
	if (declared && declared.length > 0) {
		return manifestEntries(dir, declared);
	}
	const index = ["index.ts", "index.js"]
		.map((name) => join(dir, name))
		.find((path) => existsSync(path));
	return index ? [index] : undefined;
}

/**
 * The extension files of a package or directory, found the way pi finds them: its `pi.extensions` manifest,
 * else every extension in its `extensions/` directory (one level deep), else its index.ts or index.js.
 */
export function findExtensionEntries(path: string): string[] {
	if (!isDirectory(path)) {
		return existsSync(path) ? [path] : [];
	}
	const declared = directoryEntry(path);
	if (declared) {
		return declared;
	}
	const conventional = join(path, "extensions");
	if (!isDirectory(conventional)) {
		return [];
	}
	return readdirSync(conventional, { withFileTypes: true })
		.filter(
			(entry) => !entry.name.startsWith(".") && entry.name !== "node_modules",
		)
		.flatMap((entry) => {
			const full = join(conventional, entry.name);
			if (isDirectory(full)) {
				return directoryEntry(full) ?? [];
			}
			return EXTENSION_FILE.test(entry.name) ? [full] : [];
		});
}

/** The directory of the package.json above a package's entry file. */
function packageRoot(entry: string): string {
	let dir = dirname(entry);
	while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) {
		dir = dirname(dir);
	}
	return dir;
}

/**
 * Aliases mapping pi's host packages to pi-action's copies, like pi's extension loader: the pi-ai root is the
 * compat entry point (a superset of the root), and each exported subpath (wildcards expanded) its own file.
 */
function hostAliases(): Record<string, string> {
	const root = packageRoot(fileURLToPath(import.meta.resolve(PI_AI)));
	const packageJson = join(root, "package.json");
	const exportsField = field(
		JSON.parse(readFileSync(packageJson, "utf8")),
		"exports",
	);
	const exports = isRecord(exportsField) ? Object.entries(exportsField) : [];
	const subpaths = exports.flatMap(([key, target]): [string, string][] => {
		const file = isRecord(target) ? field(target, "import") : target;
		if (typeof file !== "string" || key === "./package.json") {
			return [];
		}
		const name = key.slice(2);
		const star = name.indexOf("*");
		if (star === -1) {
			return [[name, resolve(root, file)]];
		}
		const [prefix = "", suffix = ""] = file.split("*");
		const dir = resolve(root, prefix);
		const files = isDirectory(dir)
			? readdirSync(dir, { recursive: true, encoding: "utf8" })
			: [];
		return files
			.filter((match) => match.endsWith(suffix))
			.map((match) => [
				`${name.slice(0, star)}${match.slice(0, match.length - suffix.length)}`,
				join(dir, match),
			]);
	});
	const compat = fileURLToPath(import.meta.resolve(`${PI_AI}/compat`));
	const aliases = new Map<string, string>();
	for (const name of HOST_PACKAGES) {
		aliases.set(name, compat);
		for (const [subpath, file] of subpaths) {
			if (subpath) {
				aliases.set(`${name}/${subpath}`, file);
			}
		}
	}
	return Object.fromEntries(aliases);
}

const SUPPORTED_API = new Set([
	"registerProvider",
	"unregisterProvider",
	"events",
]);

function isProvider(value: unknown): value is Provider {
	return (
		isRecord(value) &&
		typeof value["id"] === "string" &&
		isRecord(value["auth"]) &&
		["getModels", "stream", "streamSimple"].every(
			(method) => typeof value[method] === "function",
		)
	);
}

/**
 * The `pi` object an extension factory receives. It keeps provider registrations; everything else an
 * extension can do in the coding agent (tools, commands, event handlers, UI) is ignored with a warning,
 * because pi-action runs pi-durable conversations, not the coding agent.
 */
export function createExtensionApi(
	source: string,
	providers: ExtensionProvider[],
	log: ExtensionLog,
): object {
	const warned = new Set<string>();
	const api = {
		registerProvider(nameOrProvider: unknown, config?: unknown): void {
			if (isProvider(nameOrProvider)) {
				const { id } = nameOrProvider;
				providers.push({
					id,
					source,
					kind: "provider",
					provider: nameOrProvider,
				});
				return;
			}
			if (typeof nameOrProvider !== "string" || !nameOrProvider) {
				throw new Error(
					"registerProvider() takes a provider name and config, or a pi-ai Provider",
				);
			}
			const parsed = parseProviderConfig(nameOrProvider, config);
			if (parsed.ignored.length > 0) {
				log.warning(
					`${source}: provider ${nameOrProvider}: ${parsed.ignored.join(", ")} not supported by pi-action; ignored`,
				);
			}
			providers.push({
				id: nameOrProvider,
				source,
				kind: "config",
				config: parsed,
			});
		},
		unregisterProvider(name: unknown): void {
			const kept = providers.filter(
				(entry) => !(entry.id === name && entry.source === source),
			);
			providers.splice(0, providers.length, ...kept);
		},
		events: {
			on: () => () => undefined,
			emit: () => undefined,
		},
	};
	return new Proxy(api, {
		get(target, property, receiver) {
			if (typeof property !== "string" || SUPPORTED_API.has(property)) {
				const value: unknown = Reflect.get(target, property, receiver);
				return value;
			}
			if (property === "then") {
				return undefined; // not a thenable: `await pi` must not call a stub
			}
			return () => {
				if (!warned.has(property)) {
					warned.add(property);
					log.warning(
						`${source}: pi.${property}() is not supported by pi-action (only providers are); ignored`,
					);
				}
			};
		},
	});
}

async function loadEntry(
	entry: string,
	jiti: ReturnType<typeof createJiti>,
	providers: ExtensionProvider[],
	log: ExtensionLog,
	cwd: string,
): Promise<void> {
	const shown =
		isAbsolute(entry) && !relative(cwd, entry).startsWith("..")
			? relative(cwd, entry)
			: entry;
	const factory: unknown = await jiti.import(entry, { default: true });
	if (typeof factory !== "function") {
		throw new TypeError(`${shown} has no default export function`);
	}
	const before = providers.length;
	await Reflect.apply(factory, undefined, [
		createExtensionApi(shown, providers, log),
	]);
	const ids = providers.slice(before).map((p) => p.id);
	log.info(
		ids.length > 0
			? `Loaded pi extension ${shown}: provider ${ids.join(", ")}`
			: `Loaded pi extension ${shown} (it registered no provider)`,
	);
}

/**
 * Installs and loads the `extensions` input and returns the providers they registered. npm packages are
 * installed into a temporary directory (never the repository) without lifecycle scripts; paths load in place.
 * Extensions run in this process with its permissions and environment.
 */
export async function loadExtensions(
	options: LoadExtensionsOptions,
): Promise<ExtensionProvider[]> {
	const { specs, cwd, log } = options;
	const providers: ExtensionProvider[] = [];
	if (specs.length === 0) {
		return providers;
	}
	const env = options.env ?? process.env;
	const sources = specs.map((spec) => ({
		spec,
		source: classifySpec(spec, cwd),
	}));
	const npmSpecs = sources.flatMap(({ source }) =>
		source.kind === "npm" ? [source.spec] : [],
	);
	const roots = sources.flatMap(({ source }) =>
		source.kind === "path" ? [{ name: source.path, path: source.path }] : [],
	);
	if (npmSpecs.length > 0) {
		log.info(`Installing pi extensions: ${npmSpecs.join(", ")}`);
		const installed = await installPackages(
			npmSpecs,
			env,
			options.runNpm ?? defaultRunNpm,
		);
		roots.push(...installed);
	}
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: hostAliases(),
	});
	for (const root of roots) {
		const entries = findExtensionEntries(root.path);
		if (entries.length === 0) {
			if (!existsSync(root.path)) {
				throw new Error(`Extension ${root.name} not found`);
			}
			log.warning(
				`${root.name} has no pi extensions; it is installed for other extensions to import`,
			);
		}
		for (const entry of entries) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- extensions load one after another, in order, like pi's
				await loadEntry(entry, jiti, providers, log, cwd);
			} catch (error) {
				throw new Error(
					`Could not load pi extension ${root.name}: ${getErrorMessage(error)}`,
					{
						cause: error,
					},
				);
			}
		}
	}
	return providers;
}
