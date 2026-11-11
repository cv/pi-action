import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Extension } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import {
	createDurableExtensions,
	type DurableExtensionsOptions,
} from "./durable-extensions.ts";
import type { DurableExtensionFactory } from "./extensions.ts";
import { createLogger, tempDir } from "./test-helpers.ts";
import type { DurableHostOptions, DurableUi } from "./types.ts";

const TAKEN = /named "coding-tools", which is already taken/u;
const FAILED = /Could not create pi-durable extension b\.ts: boom/u;

function factory(
	source: string,
	create: (options: DurableHostOptions) => Promise<Extension>,
): DurableExtensionFactory & { create: ReturnType<typeof vi.fn> } {
	return { source, create: vi.fn(create) };
}

function options(
	overrides: Partial<DurableExtensionsOptions> = {},
): DurableExtensionsOptions {
	return {
		cwd: tempDir(),
		agentDir: undefined,
		trustProject: false,
		ui: undefined,
		log: createLogger(),
		env: { RUNNER_TEMP: tempDir() },
		...overrides,
	};
}

describe("createDurableExtensions", () => {
	it("does nothing without pi-durable extensions", async () => {
		const opts = options();
		await expect(createDurableExtensions([], opts)).resolves.toStrictEqual([]);
		expect(readdirSync(String(opts.env["RUNNER_TEMP"]))).toStrictEqual([]);
	});

	it("passes the host options, with a temp agent directory under RUNNER_TEMP", async () => {
		const ui: DurableUi = {
			ask: vi.fn<DurableUi["ask"]>(),
			notify: vi.fn<DurableUi["notify"]>(),
		};
		const opts = options({ trustProject: true, ui });
		const a = factory("a.ts", async () => ({
			name: "a",
			tools: [
				{
					name: "t",
					description: "",
					parameters: {},
					execute: vi.fn(),
				},
			],
		}));
		const b = factory("b.ts", async () => ({ name: "b" }));

		const extensions = await createDurableExtensions([a, b], opts);

		expect(extensions.map((e) => e.name)).toStrictEqual(["a", "b"]);
		const [[host]] = a.create.mock.calls as [[DurableHostOptions]];
		expect(host).toMatchObject({ cwd: opts.cwd, trustProject: true, ui });
		const prefix = join(String(opts.env["RUNNER_TEMP"]), "pi-action-agent-");
		expect(host.agentDir.startsWith(prefix)).toBe(true);
		expect(existsSync(host.agentDir)).toBe(true);
		expect(b.create.mock.calls[0]?.[0]).toMatchObject({
			agentDir: host.agentDir,
		});
		expect(opts.log.info).toHaveBeenCalledWith(
			"pi-durable extension a (a.ts): t",
		);
		expect(opts.log.info).toHaveBeenCalledWith(
			"pi-durable extension b (b.ts): no tools",
		);
	});

	it("uses agent_dir relative to the workspace, and gives no ui when there is none", async () => {
		const opts = options({ agentDir: ".pi-agent" });
		const a = factory("a.ts", async () => ({ name: "a" }));
		await createDurableExtensions([a], opts);
		const host = a.create.mock.calls[0]?.[0] as DurableHostOptions;
		expect(host.agentDir).toBe(join(opts.cwd, ".pi-agent"));
		expect(existsSync(host.agentDir)).toBe(true);
		expect("ui" in host).toBe(false);
	});

	it("rejects taken names and reports failing factories", async () => {
		await expect(
			createDurableExtensions(
				[factory("a.ts", async () => ({ name: "coding-tools" }))],
				options(),
			),
		).rejects.toThrow(TAKEN);
		await expect(
			createDurableExtensions(
				[
					factory("b.ts", async () => {
						throw new Error("boom");
					}),
				],
				options(),
			),
		).rejects.toThrow(FAILED);
	});
});
