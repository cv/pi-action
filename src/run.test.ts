import { resolve } from "node:path";

import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";

import type { ActionInputs } from "./inputs.ts";
import { pushThread } from "./push.ts";
import { type ActionDependencies, run } from "./run.ts";
import {
	createActionInputs,
	createComment,
	createLogger,
	createMockGitHubClient,
	fauxModels,
	git,
	tempRemote,
} from "./test-helpers.ts";
import type { GitHubComment, GitHubReaction } from "./types.ts";

const REF = "refs/pi/threads/42";
const FIRST_COMMIT = /pi-durable: seq 1 /u;
const COMMIT_ID = /^[0-9a-f]{40}$/u;

/** A bare "GitHub" remote, a fresh runner checkout per run, a faux model, and a fake GitHub API. */
function world() {
	const { remote, clone } = tempRemote();
	const { faux, models, model } = fauxModels();
	const comments: GitHubComment[] = [];
	const gh = createMockGitHubClient(comments);
	let nextId = 100;
	const comment = (body: string, overrides: Partial<GitHubComment> = {}) => {
		nextId += 1;
		const c = createComment({
			id: nextId,
			body,
			created_at: new Date().toISOString(),
			html_url: `https://github.com/o/r/issues/42#issuecomment-${nextId}`,
			...overrides,
		});
		comments.push(c);
		return c;
	};
	/** The comment IDs that got `reaction`. */
	const reacted = (reaction: GitHubReaction) =>
		vi
			.mocked(gh.addReaction)
			.mock.calls.filter(([, r]) => r === reaction)
			.map(([target]) => target.commentId);
	const deps = (
		trigger: GitHubComment | undefined,
		inputs: Partial<ActionInputs> = {},
		payload?: Record<string, unknown>,
	): ActionDependencies => ({
		inputs: createActionInputs({
			provider: model.provider,
			model: model.id,
			timeout: 30,
			pollInterval: 0.05,
			...inputs,
		}),
		payload: payload ?? {
			comment: trigger,
			issue: {
				number: 42,
				title: "Fix the thing",
				body: "It is broken",
				user: { login: "o", type: "User" },
			},
		},
		createClient: () => gh,
		log: createLogger(),
		cwd: clone("--depth", "1"),
		createModels: async () => models,
		env: {
			GITHUB_REPOSITORY: "o/r",
			GITHUB_RUN_ID: "777",
			GITHUB_RUN_ATTEMPT: "1",
			GITHUB_ACTOR: "dispatcher",
		},
	});
	return { remote, faux, gh, comment, deps, reacted };
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
		expect(w.reacted("eyes")).toStrictEqual([trigger.id]);
		expect(w.reacted("rocket")).toStrictEqual([trigger.id]);
		const log = git(w.remote, "log", "--format=%s", REF);
		expect(log).toMatch(FIRST_COMMIT);
	});

	it("answers with a provider from a pi extension (the extensions input)", async () => {
		const w = world();
		const trigger = w.comment("@pi say something");
		const deps = w.deps(trigger, {
			provider: "echo",
			model: "echo-1",
			extensions: [resolve("test/fixtures/extensions/echo-provider")],
		});

		await run({
			...deps,
			createModels: undefined, // the action's own model setup, extensions included
			env: { ...deps.env, ECHO_API_KEY: "echo-secret" },
		});

		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain(
			"echo from echo/echo-1 with key echo-secret",
		);
		expect(deps.log.warning).toHaveBeenCalledWith(
			expect.stringContaining("pi.registerTool() is not supported"),
		);
	});

	it("reports an extension that fails to load on the issue", async () => {
		const w = world();
		const trigger = w.comment("@pi hello");
		const deps = w.deps(trigger, { extensions: ["./does-not-exist"] });

		await run({ ...deps, createModels: undefined });

		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain("Extension ");
		expect(w.gh.posted[0]).toContain("does-not-exist not found");
	});

	it("continues the same conversation in a later run on a fresh runner", async () => {
		const w = world();
		let seen: string[] = [];
		const remember: FauxResponseStep = (context) => {
			seen = userTexts(context.messages);
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
			`**@user** commented (https://github.com/o/r/issues/42#issuecomment-102):\n\nand now the second`,
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

		expect(w.reacted("rocket")).toStrictEqual(
			expect.arrayContaining([missed.id, current.id]),
		);
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
				contextAtEnd = userTexts(context.messages);
				return fauxAssistantMessage("Done, docs too.");
			},
			fauxAssistantMessage("Docs were already handled."),
		]);

		await run(w.deps(w.comment("@pi fix it")));

		expect(late).toBeDefined();
		expect(contextAtEnd.some((t) => t.includes("**@bob** commented"))).toBe(
			true,
		);
		expect(w.reacted("rocket")).toContain(late?.id);
	});

	it("aborts at the timeout, reports it, and still saves the thread", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
				stopReason: "toolUse",
			}),
		]);
		const trigger = w.comment("@pi run forever");
		const deps = w.deps(trigger, { timeout: 0.3 });

		await run(deps);

		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain("Timeout after 0.3 seconds");
		expect(w.reacted("confused")).toStrictEqual([trigger.id]);
		expect(git(w.remote, "rev-parse", REF).trim()).toMatch(COMMIT_ID);
	}, 20_000);

	it("does not repeat a failure report in a later run", async () => {
		const w = world();
		// The provider fails until someone asks again.
		const flaky: FauxResponseStep = (context) =>
			// oxlint-disable-next-line vitest/no-conditional-in-test -- the fake provider's behavior
			userTexts(context.messages).at(-1)?.includes("again") === true
				? fauxAssistantMessage("recovered")
				: fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "provider exploded",
					});
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
		await run(w.deps(w.comment("@pi hack", { author_association: "NONE" })));
		expect(w.gh.posted).toHaveLength(0);
		expect(w.gh.addReaction).not.toHaveBeenCalled();
	});

	it("reports an unknown model", async () => {
		const w = world();
		await run(
			w.deps(w.comment("@pi hi"), { provider: "nope", model: "missing" }),
		);
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
		const { payload } = deps;

		// Simulate a step killed before its final push: rewind the remote ref.
		const tip = git(deps.cwd, "rev-parse", REF).trim();
		const parent = git(deps.cwd, "rev-parse", `${REF}~3`).trim();
		git(w.remote, "update-ref", REF, parent);

		await expect(pushThread(payload, deps.cwd, log)).resolves.toBe("pushed");
		expect(git(w.remote, "rev-parse", REF).trim()).toBe(tip);
		await expect(pushThread(payload, deps.cwd, log)).resolves.toBe(
			"up-to-date",
		);
		await expect(
			pushThread({ issue: { number: 7 } }, deps.cwd, log),
		).resolves.toBe("nothing");
		await expect(pushThread({}, deps.cwd, log)).resolves.toBe("nothing");
		// pr_number names the thread, as in the main step, even when the event has an issue.
		await expect(
			pushThread({ issue: { number: 7 } }, deps.cwd, log, 42),
		).resolves.toBe("up-to-date");

		// Another run moved the remote on: never overwrite it.
		git(
			w.remote,
			"update-ref",
			REF,
			git(w.remote, "commit-tree", "-m", "other", `${REF}^{tree}`).trim(),
		);
		await expect(pushThread(payload, deps.cwd, log)).resolves.toBe("failed");
		expect(log.warning).toHaveBeenCalledWith(
			expect.stringContaining("was rejected"),
		);
	});
});

describe("run (durable) with main's modes", () => {
	const outputs = (deps: ActionDependencies) =>
		Object.fromEntries(vi.mocked(deps.log.setOutput).mock.calls);

	it("output mode answers a trigger without comments or reactions, and keeps the thread", async () => {
		const w = world();
		w.faux.setResponses([fauxAssistantMessage("All good.")]);
		const deps = w.deps(w.comment("@pi check"), { outputMode: "output" });

		await run(deps);

		expect(outputs(deps)).toStrictEqual({
			success: "true",
			response: "All good.",
		});
		expect(w.gh.posted).toHaveLength(0);
		expect(w.gh.addReaction).not.toHaveBeenCalled();
		expect(git(w.remote, "rev-parse", REF).trim()).toMatch(COMMIT_ID);
	});

	it("a direct prompt runs in memory and stores nothing", async () => {
		const w = world();
		w.faux.setResponses([fauxAssistantMessage("Release notes.")]);
		const deps = w.deps(
			undefined,
			{ outputMode: "output", prompt: "Write release notes" },
			{},
		);

		await run(deps);

		expect(outputs(deps)).toMatchObject({
			success: "true",
			response: "Release notes.",
		});
		expect(git(w.remote, "for-each-ref", "refs/pi")).toBe("");
	});

	it("pr_number reviews join that PR's thread and can post to it", async () => {
		const w = world();
		vi.mocked(w.gh.getPullRequest).mockResolvedValue({
			number: 42,
			title: "Add feature",
			body: "Adds it",
		});
		let first: string[] = [];
		w.faux.setResponses([
			(context) => {
				first = userTexts(context.messages);
				return fauxAssistantMessage("Looks fine.");
			},
			fauxAssistantMessage("Still fine."),
		]);
		await run(w.deps(undefined, { prNumber: 42, prompt: "Review it" }, {}));
		expect(first[0]).toContain("Add feature");
		expect(first[0]).toContain("Review it");
		expect(w.gh.posted[0]).toContain("Looks fine.");
		expect(git(w.remote, "rev-parse", REF).trim()).toMatch(COMMIT_ID);

		// A second dispatch continues the thread as a follow-up from the workflow's actor.
		const deps = w.deps(
			undefined,
			{ prNumber: 42, prompt: "Again", outputMode: "output" },
			{},
		);
		deps.env = { ...deps.env, GITHUB_RUN_ID: "778" };
		await run(deps);
		expect(outputs(deps)).toMatchObject({ response: "Still fine." });
	});

	it("re-prompts once for a summary when the answer is empty", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage(""),
			fauxAssistantMessage("Summary: done."),
		]);
		await run(w.deps(w.comment("@pi do it")));
		expect(w.gh.posted).toHaveLength(1);
		expect(w.gh.posted[0]).toContain("Summary: done.");
	});

	it("reports two empty answers as a failure", async () => {
		const w = world();
		w.faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
		const deps = w.deps(w.comment("@pi do it"), { outputMode: "output" });
		await run(deps);
		expect(outputs(deps)).toMatchObject({
			success: "false",
			response:
				"Agent failed to provide a response after two attempts. First attempt: Agent returned empty response. Retry attempt: Agent returned empty response.",
		});
	});

	it("output mode reports setup failures as outputs", async () => {
		const w = world();
		const deps = w.deps(w.comment("@pi hi"), {
			outputMode: "output",
			provider: "nope",
			model: "missing",
		});
		await run(deps);
		expect(outputs(deps)).toMatchObject({ success: "false" });
		expect(outputs(deps)).toMatchObject({
			response: expect.stringContaining("Model not found: nope/missing"),
		});
		expect(w.gh.posted).toHaveLength(0);
	});
});
