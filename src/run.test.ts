import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
	tempDir,
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
		summary: vi.fn(async (_markdown: string) => undefined),
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

/** The text of the last tool result the model saw. */
const toolText = (messages: { role: string; content: unknown }[]): string => {
	const result = messages.findLast((m) => m.role === "toolResult");
	return Array.isArray(result?.content)
		? (result.content as { text?: string }[]).map((b) => b.text ?? "").join("")
		: "";
};

/** Git as on a runner: no global or system config, so no identity. */
function runnerGitEnv(): Record<string, string> {
	const home = tempDir();
	const global = join(home, "gitconfig");
	writeFileSync(global, "");
	return { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" };
}

describe("run (durable)", () => {
	it("ignores edited comments that are not answers to questions", async () => {
		const w = world();
		const trigger = w.comment("@pi fix it");
		const deps = w.deps(
			undefined,
			{},
			{
				action: "edited",
				comment: trigger,
				issue: {
					number: 42,
					title: "Fix the thing",
					body: "It is broken",
					user: { login: "o", type: "User" },
				},
			},
		);
		await run(deps);
		expect(deps.log.info).toHaveBeenCalledWith(
			"An edited comment that is not an answer to a question; skipping",
		);
		expect(w.gh.addReaction).not.toHaveBeenCalled();
		expect(w.gh.posted).toHaveLength(0);
	});

	it("gives the agent's tools GH_TOKEN and a git identity when the runner has none", async () => {
		const w = world();
		w.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", {
						command:
							'printf "%s|%s|%s" "$GH_TOKEN" "$GIT_AUTHOR_NAME" "$GIT_COMMITTER_EMAIL"',
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) =>
				fauxAssistantMessage(`Tool said: ${toolText(context.messages)}`),
		]);
		const deps = w.deps(w.comment("@pi who am I?"));
		deps.env = { ...deps.env, ...runnerGitEnv() };

		await run(deps);

		expect(w.gh.posted[0]).toContain(
			"Tool said: test-token|github-actions[bot]|41898282+github-actions[bot]@users.noreply.github.com",
		);
		expect(deps.log.info).toHaveBeenCalledWith(
			"The agent's tools get GH_TOKEN, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL",
		);
		// Without pi-durable extensions, the action's own environment is left alone.
		expect(deps.env).not.toHaveProperty("GH_TOKEN");
	});

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

describe("run with a pi-durable extension (installed from npm)", () => {
	let packs = "";
	let spec = "";
	beforeAll(() => {
		packs = mkdtempSync(join(tmpdir(), "pi-action-packs-"));
		execFileSync(
			"npm",
			[
				"pack",
				"--silent",
				"--pack-destination",
				packs,
				resolve("test/fixtures/extensions/durable-ask"),
			],
			{ stdio: "ignore" },
		);
		spec = `npm:file:${join(packs, readdirSync(packs)[0] ?? "")}`;
	}, 60_000);

	afterAll(() => {
		rmSync(packs, { recursive: true, force: true });
	});

	/**
	 * The model calls the extension's ask_user tool until it reports something other than a posted question, then
	 * says what it reported. A run that posts a question ends without asking the model again (`terminate`).
	 */
	const askUntilAnswered: FauxResponseStep = (context) => {
		const said = toolText(context.messages);
		return said === "" || said.startsWith("Question posted")
			? fauxAssistantMessage([fauxToolCall("ask_user", {})], {
					stopReason: "toolUse",
				})
			: fauxAssistantMessage(`Tool said: ${said}`);
	};

	function durableWorld(inputs: Partial<ActionInputs> = {}) {
		const w = world();
		w.faux.setResponses(Array.from({ length: 10 }, () => askUntilAnswered));
		const runnerTemp = tempDir();
		/** A run on the extension's runner, for `payload` (default: a new `@pi deploy` comment). */
		const durableDeps = (payload?: Record<string, unknown>) => {
			const deps = w.deps(
				payload ? undefined : w.comment("@pi deploy"),
				{ extensions: [spec], ...inputs },
				payload,
			);
			deps.env = { ...process.env, ...deps.env, RUNNER_TEMP: runnerTemp };
			return deps;
		};
		/** Someone with write access ticks `label` on question comment `id`: the `issue_comment` `edited` event. */
		const tick = (id: number, label: string, sender = "ada") => {
			const before = w.gh.bodies.get(id) ?? "";
			const after = before.replace(`- [ ] ${label}`, `- [x] ${label}`);
			w.gh.bodies.set(id, after);
			return {
				action: "edited",
				issue: {
					number: 42,
					title: "Fix the thing",
					body: "It is broken",
					user: { login: "o", type: "User" },
				},
				comment: {
					id,
					body: after,
					user: { login: "github-actions[bot]", type: "Bot" },
					author_association: "NONE",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					html_url: `https://github.com/o/r/issues/42#issuecomment-${id}`,
				},
				changes: { body: { from: before } },
				sender: { login: sender, type: "User" },
			};
		};
		return { ...w, durableDeps, tick, runnerTemp, deps: durableDeps() };
	}

	it("posts a question, ends the run quietly, and continues when a box is ticked", async () => {
		const d = durableWorld();
		let seen: string[] = [];
		await run(d.deps);

		// The run ends on the question: no pi Response comment, no reaction for a result.
		expect(d.gh.posted).toHaveLength(1);
		expect(d.gh.posted[0]).toContain("### ❓ Deploy?");
		expect(d.gh.posted[0]).toContain("- [ ] Yes\n- [ ] No");
		expect(d.deps.log.info).toHaveBeenCalledWith(
			"pi asked a question and ended its turn; waiting for an answer to https://github.com/o/r/issues/1#c1",
		);
		expect(d.reacted("rocket")).toHaveLength(0);
		expect(d.reacted("confused")).toHaveLength(0);
		expect(d.gh.getComment).not.toHaveBeenCalled();

		// Ticking Yes starts a new run: the answer reaches the thread, and the tool asks its next question.
		const yes = d.durableDeps(d.tick(1001, "Yes"));
		await run(yes);
		expect(d.gh.bodies.get(1001)).toContain("**✅ Answered: Yes by @ada**");
		expect(d.gh.posted).toHaveLength(2);
		expect(d.gh.posted[1]).toContain("- [ ] red\n- [ ] green");

		// Ticking green: the tool gets both answers, and pi answers.
		d.faux.setResponses([
			async (...args) => {
				seen = userTexts(args[0].messages);
				return askUntilAnswered(...args);
			},
			askUntilAnswered,
		]);
		const green = d.durableDeps(d.tick(1002, "green"));
		await run(green);
		expect(d.gh.posted).toHaveLength(3);
		expect(d.gh.posted[2]).toContain(
			`Tool said: confirm=true select=green agentDir=${join(d.runnerTemp, "pi-action-agent-")}`,
		);
		expect(seen.at(-1)).toBe(
			"**@ada** answered pi's question *Color* (https://github.com/o/r/issues/42#issuecomment-1002): green",
		);
		expect(d.reacted("rocket")).toStrictEqual([1002]);
		expect(green.summary).toHaveBeenCalledWith(
			expect.stringContaining("deploy=true"),
		);
		expect(d.deps.log.info).toHaveBeenCalledWith(
			expect.stringContaining("loading only the pi-durable one"),
		);
		expect(d.deps.log.info).toHaveBeenCalledWith(
			"durable-ask: trustProject=false",
		);
	}, 120_000);

	it("ignores a box ticked by someone without write access", async () => {
		const d = durableWorld();
		await run(d.deps);
		vi.mocked(d.gh.getCollaboratorPermission).mockResolvedValue("read");
		const deps = d.durableDeps(d.tick(1001, "Yes", "mallory"));
		await run(deps);
		expect(deps.log.warning).toHaveBeenCalledWith(
			expect.stringContaining("@mallory ticked a box"),
		);
		expect(d.gh.bodies.get(1001)).not.toContain("Answered");
		expect(d.gh.posted).toHaveLength(1);
	}, 120_000);

	it("sets the tools' variables in the environment the extension shares, unless set", async () => {
		const d = durableWorld({ outputMode: "output" });
		const env = { ...d.deps.env, ...runnerGitEnv() };
		Reflect.deleteProperty(env, "GH_TOKEN");
		Reflect.deleteProperty(env, "GITHUB_TOKEN");
		d.deps.env = env;

		await run(d.deps);

		expect(env).toMatchObject({
			GH_TOKEN: "test-token",
			GIT_AUTHOR_NAME: "pi-action tests", // set by the workflow (here, the test setup)
		});
	}, 120_000);

	it("gives the extension no UI in output mode, and passes trust_project", async () => {
		const d = durableWorld({ outputMode: "output", trustProject: true });

		await run(d.deps);

		expect(
			Object.fromEntries(vi.mocked(d.deps.log.setOutput).mock.calls),
		).toMatchObject({
			success: "true",
			response: expect.stringContaining("Tool said: no ui"),
		});
		expect(d.gh.posted).toHaveLength(0);
		expect(d.deps.log.info).toHaveBeenCalledWith(
			"durable-ask: trustProject=true",
		);
	}, 120_000);
});
