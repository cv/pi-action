import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushThread } from "./push.js";
import { type ActionDependencies, type ActionInputs, run } from "./run.js";
import { createComment, createMockGitHubClient } from "./test-helpers.js";
import type { GitHubComment } from "./types.js";

const REF = "refs/pi/threads/42";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/** A bare "GitHub" remote, a fresh runner checkout per run, a faux model, and a fake GitHub API. */
function world() {
	const root = mkdtempSync(join(tmpdir(), "pi-action-run-"));
	dirs.push(root);
	const remote = join(root, "remote.git");
	git(root, "init", "-q", "--bare", "-b", "main", remote);
	const seed = join(root, "seed");
	git(root, "init", "-q", "-b", "main", seed);
	git(
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
	git(seed, "push", "-q", remote, "main");
	let runners = 0;
	const checkout = () => {
		const dir = join(root, `runner-${++runners}`);
		git(root, "clone", "-q", "--depth", "1", `file://${remote}`, dir);
		return dir;
	};
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const comments: GitHubComment[] = [];
	const gh = createMockGitHubClient(comments);
	let nextId = 100;
	const comment = (body: string, overrides: Partial<GitHubComment> = {}) => {
		const c = createComment({
			id: ++nextId,
			body,
			created_at: new Date().toISOString(),
			html_url: `https://github.com/o/r/issues/42#issuecomment-${nextId}`,
			...overrides,
		});
		comments.push(c);
		return c;
	};
	const deps = (
		trigger: GitHubComment,
		inputs: Partial<ActionInputs> = {},
	): ActionDependencies => ({
		inputs: {
			triggerPhrase: "@pi",
			allowedBots: [],
			modelConfig: { provider: model.provider, model: model.id, timeout: 30 },
			githubToken: "token",
			piAuthJson: undefined,
			promptTemplate: undefined,
			pollInterval: 0.05,
			...inputs,
		},
		context: {
			payload: {
				comment: trigger,
				issue: {
					number: 42,
					title: "Fix the thing",
					body: "It is broken",
					user: { login: "o", type: "User" },
				},
			},
			repo: { owner: "o", name: "r" },
		},
		createClient: () => gh,
		log: {
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
			setFailed: vi.fn(),
		},
		cwd: checkout(),
		createModels: async () => models,
	});
	return { remote, faux, gh, comment, deps, comments };
}

const userTexts = (messages: { role: string; content: unknown }[]) =>
	messages
		.filter((m) => m.role === "user")
		.map((m) =>
			typeof m.content === "string"
				? m.content
				: (m.content as { type: string; text?: string }[])
						.map((b) => b.text ?? "")
						.join(""),
		);

describe("run (durable)", () => {
	it("answers a trigger, posts once, and pushes the thread to the remote", async () => {
		const w = world();
		w.faux.setResponses([fauxAssistantMessage("Fixed it.")]);
		const trigger = w.comment("@pi please fix");

		await run(w.deps(trigger));

		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain("### 🤖 pi Response\n\nFixed it.");
		expect(w.gh.posted[0]).toContain(REF);
		expect(w.gh.addReactionToComment).toHaveBeenCalledWith(
			trigger.id,
			"eyes",
			"comment",
		);
		expect(w.gh.addReactionToComment).toHaveBeenCalledWith(
			trigger.id,
			"rocket",
			"comment",
		);
		const log = git(w.remote, "log", "--format=%s", REF);
		expect(log).toMatch(/pi-durable: seq 1 /);
	});

	it("continues the same conversation in a later run on a fresh runner", async () => {
		const w = world();
		let seen: string[] = [];
		const remember: FauxResponseStep = (context) => {
			seen = userTexts(context.messages as never);
			return fauxAssistantMessage(`I remember ${seen.length} requests.`);
		};
		w.faux.setResponses([fauxAssistantMessage("First answer."), remember]);
		await run(w.deps(w.comment("@pi first task")));
		await run(w.deps(w.comment("@pi and now the second")));

		expect(w.gh.posted).toHaveLength(2);
		expect(w.gh.posted[1]).toContain("I remember 2 requests.");
		expect(seen[0]).toContain("first task");
		expect(seen[0]).toContain("Fix the thing"); // the first message carries the issue context
		expect(seen[1]).toBe(
			`**@user** commented (https://github.com/o/r/issues/42#issuecomment-${102}):\n\nand now the second`,
		);
	});

	it("picks up comments a cancelled run never handled", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		await run(w.deps(w.comment("@pi one")));
		const missed = w.comment("@pi two (its run was cancelled while pending)");
		const current = w.comment("@pi three");

		await run(w.deps(current));

		const rockets = vi
			.mocked(w.gh.addReactionToComment)
			.mock.calls.filter(([, reaction]) => reaction === "rocket")
			.map(([id]) => id);
		expect(rockets).toEqual(expect.arrayContaining([missed.id, current.id]));
		expect(w.gh.posted.length).toBeGreaterThanOrEqual(2);
		// Nothing is answered twice: the first comment was already handled.
		expect(w.gh.posted.filter((p) => p.includes("one"))).toHaveLength(1);
	});

	it("adds comments posted while pi works to the running conversation", async () => {
		const w = world();
		let late: GitHubComment | undefined;
		let contextAtEnd: string[] = [];
		w.faux.setResponses([
			() => {
				late = w.comment("@pi also update the docs", {
					user: { login: "bob", type: "User" },
				});
				return fauxAssistantMessage(
					[fauxToolCall("bash", { command: "sleep 0.5" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				contextAtEnd = userTexts(context.messages as never);
				return fauxAssistantMessage("Done, docs too.");
			},
			fauxAssistantMessage("Docs were already handled."),
		]);

		await run(w.deps(w.comment("@pi fix it")));

		expect(late).toBeDefined();
		expect(contextAtEnd.some((t) => t.includes("**@bob** commented"))).toBe(
			true,
		);
		expect(w.gh.addReactionToComment).toHaveBeenCalledWith(
			late?.id,
			"rocket",
			"comment",
		);
	});

	it("aborts at the timeout, reports it, and still saves the thread", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
				stopReason: "toolUse",
			}),
		]);
		const trigger = w.comment("@pi run forever");
		const deps = w.deps(trigger);
		deps.inputs.modelConfig.timeout = 0.3;

		await run(deps);

		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain("Timeout after 0.3 seconds");
		expect(w.gh.addReactionToComment).toHaveBeenCalledWith(
			trigger.id,
			"confused",
			"comment",
		);
		expect(git(w.remote, "rev-parse", REF).trim()).toMatch(/^[0-9a-f]{40}$/);
	}, 20_000);

	it("does not repeat a failure report in a later run", async () => {
		const w = world();
		// The provider fails until someone asks again.
		const flaky: FauxResponseStep = (context) =>
			userTexts(context.messages as never)
				.at(-1)
				?.includes("again")
				? fauxAssistantMessage("recovered")
				: (fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "provider exploded",
					}) as AssistantMessage);
		w.faux.setResponses(Array.from({ length: 10 }, () => flaky));
		await run(w.deps(w.comment("@pi try")));
		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain("pi Error");

		await run(w.deps(w.comment("@pi try again")));
		expect(w.gh.posted).toHaveLength(2);
		expect(w.gh.posted[1]).toContain("recovered");
	}, 30_000);

	it("ignores triggers from users without write access", async () => {
		const w = world();
		const deps = w.deps(w.comment("@pi hack", { author_association: "NONE" }));
		await run(deps);
		expect(w.gh.posted).toHaveLength(0);
		expect(w.gh.addReactionToComment).not.toHaveBeenCalled();
	});

	it("reports an unknown model", async () => {
		const w = world();
		const deps = w.deps(w.comment("@pi hi"), {
			modelConfig: { provider: "nope", model: "missing", timeout: 30 },
		});
		await run(deps);
		expect(w.gh.posted[0]).toContain("Model not found: nope/missing");
	});
});

describe("pushThread (the always() step)", () => {
	it("pushes a thread the main step left unpushed, and is a no-op otherwise", async () => {
		const w = world();
		w.faux.setResponses([fauxAssistantMessage("ok")]);
		const deps = w.deps(w.comment("@pi go"));
		await run(deps);
		const log = { info: vi.fn(), warning: vi.fn() };
		const payload = deps.context.payload;

		// Simulate a step killed before its final push: rewind the remote ref.
		const tip = git(deps.cwd, "rev-parse", REF).trim();
		const parent = git(deps.cwd, "rev-parse", `${REF}~3`).trim();
		git(w.remote, "update-ref", REF, parent);

		expect(await pushThread(payload, deps.cwd, log)).toBe("pushed");
		expect(git(w.remote, "rev-parse", REF).trim()).toBe(tip);
		expect(await pushThread(payload, deps.cwd, log)).toBe("pushed");
		expect(await pushThread({ issue: { number: 7 } }, deps.cwd, log)).toBe(
			"nothing",
		);
		expect(await pushThread({}, deps.cwd, log)).toBe("nothing");

		// Another run moved the remote on: never overwrite it.
		git(
			w.remote,
			"update-ref",
			REF,
			git(w.remote, "commit-tree", "-m", "other", `${REF}^{tree}`).trim(),
		);
		expect(await pushThread(payload, deps.cwd, log)).toBe("failed");
		expect(log.warning).toHaveBeenCalled();
	});
});
