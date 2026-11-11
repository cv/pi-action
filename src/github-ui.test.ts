import { describe, expect, it, vi } from "vitest";

import {
	createGitHubUi,
	type GitHubUiOptions,
	isQuestionComment,
	readAnswerReply,
	readCheckboxAnswer,
} from "./github-ui.ts";
import {
	createComment,
	createLogger,
	createMockGitHubClient,
} from "./test-helpers.ts";
import type { GitHubComment } from "./types.ts";

const MARKER = "<!-- pi-action:question q1 -->";
const YES_NO = ["Yes", "No"];

const question = (...items: string[]): string =>
	[
		MARKER,
		"### ❓ Deploy?",
		"",
		"> Ship it?",
		"",
		...items,
		"",
		"<sub>Tick one box</sub>",
	].join("\n");

describe("readCheckboxAnswer", () => {
	it("reads the first ticked box, [x] or [X]", () => {
		expect(
			readCheckboxAnswer(question("- [ ] Yes", "- [x] No"), "q1", YES_NO),
		).toStrictEqual({ status: "answered", index: 1 });
		expect(
			readCheckboxAnswer(question("- [X] Yes", "- [ ] No"), "q1", YES_NO),
		).toStrictEqual({ status: "answered", index: 0 });
		expect(
			readCheckboxAnswer(question("- [x] Yes", "- [x] No"), "q1", YES_NO),
		).toStrictEqual({ status: "answered", index: 0 });
		const crlf = question("* [ ] Yes", "* [x] No").replaceAll("\n", "\r\n");
		expect(readCheckboxAnswer(crlf, "q1", YES_NO)).toStrictEqual({
			status: "answered",
			index: 1,
		});
	});

	it("reports unticked boxes as unanswered", () => {
		expect(
			readCheckboxAnswer(question("- [ ] Yes", "- [ ] No"), "q1", YES_NO),
		).toStrictEqual({ status: "unanswered" });
	});

	it("ignores task lists in the quoted message", () => {
		const body = [MARKER, "> - [x] No", "", "- [ ] Yes", "- [ ] No"].join("\n");
		expect(readCheckboxAnswer(body, "q1", YES_NO)).toStrictEqual({
			status: "unanswered",
		});
	});

	it("reports a question whose marker or options were edited as changed", () => {
		const changed = { status: "changed" };
		const ticked = question("- [x] Yes", "- [ ] No");
		expect(
			readCheckboxAnswer(ticked.replace(MARKER, ""), "q1", YES_NO),
		).toStrictEqual(changed);
		expect(readCheckboxAnswer(ticked, "q2", YES_NO)).toStrictEqual(changed);
		expect(
			readCheckboxAnswer(question("- [x] Maybe", "- [ ] No"), "q1", YES_NO),
		).toStrictEqual(changed);
		expect(
			readCheckboxAnswer(
				question("- [ ] Yes", "- [ ] No", "- [x] Other"),
				"q1",
				YES_NO,
			),
		).toStrictEqual(changed);
		expect(
			readCheckboxAnswer(question("- [x] Yes"), "q1", YES_NO),
		).toStrictEqual(changed);
	});
});

describe("readAnswerReply and isQuestionComment", () => {
	it("reads /answer replies only", () => {
		expect(readAnswerReply("/answer  main ")).toBe("main");
		expect(readAnswerReply("/ANSWER\ntwo\nlines")).toBe("two\nlines");
		expect(readAnswerReply("<!-- hidden -->/answer yes")).toBe("yes");
		expect(readAnswerReply("/answer")).toBe("");
		expect(readAnswerReply("/answered it")).toBeUndefined();
		expect(readAnswerReply("I /answer later")).toBeUndefined();
	});

	it("recognizes questions and answers, which are never triggers", () => {
		expect(isQuestionComment(`${MARKER}\n@pi asks`)).toBe(true);
		expect(isQuestionComment("  /answer @pi yes")).toBe(true);
		expect(isQuestionComment("@pi help")).toBe(false);
	});
});

/** A GitHub UI on a mock client, with a way to tick a box after some polls. */
function setup(overrides: Partial<GitHubUiOptions> = {}) {
	const comments: GitHubComment[] = [];
	const gh = createMockGitHubClient(comments);
	const log = createLogger();
	const summary = vi.fn(async (_markdown: string) => undefined);
	let ids = 0;
	const ui = createGitHubUi({
		gh,
		issueNumber: 42,
		allow: {
			allowedBots: [],
			allowedUsers: [],
			allowedAssociations: ["OWNER", "MEMBER"],
		},
		pollIntervalMs: 5,
		timeoutMs: 5000,
		log,
		summary,
		newId: () => {
			ids += 1;
			return `q${ids}`;
		},
		...overrides,
	});
	/** On poll number `polls` of a question, `edit` its body (a user ticking a box). */
	const onPoll = (polls: number, edit: (body: string) => string) => {
		let calls = 0;
		vi.mocked(gh.getComment).mockImplementation(async (id) => {
			calls += 1;
			if (calls === polls) {
				gh.bodies.set(id, edit(gh.bodies.get(id) ?? ""));
			}
			return createComment({ id, body: gh.bodies.get(id) ?? null });
		});
	};
	const tick = (label: string) => (body: string) =>
		body.replace(`- [ ] ${label}`, `- [x] ${label}`);
	return { gh, log, summary, ui, onPoll, tick, comments };
}

describe("createGitHubUi: confirm and select", () => {
	it("asks with checkboxes, waits for a tick, and shows the answer", async () => {
		const s = setup({ timeoutMs: 300_000 });
		s.onPoll(2, s.tick("Yes"));

		await expect(s.ui.confirm("Deploy?", "Ship it?")).resolves.toBe(true);

		const [posted = ""] = s.gh.posted;
		expect(posted).toContain("<!-- pi-action:question q1 -->");
		expect(posted).toContain("### ❓ Deploy?");
		expect(posted).toContain("> Ship it?");
		expect(posted).toContain("- [ ] Yes\n- [ ] No");
		expect(posted).toContain("pi waits up to 5 minutes");
		expect(s.gh.getComment).toHaveBeenCalledTimes(2);
		const final = String(s.gh.bodies.get(1001));
		expect(final).toContain("✅ Answered: Yes");
		expect(final).toContain("- [x] Yes");
		expect(final).toContain(MARKER);
		expect(final).not.toContain("Tick one box");
	});

	it("returns false for No", async () => {
		const s = setup();
		s.onPoll(1, s.tick("No"));
		await expect(s.ui.confirm("Deploy?", "")).resolves.toBe(false);
		expect(s.gh.posted[0]).not.toContain("\n> ");
	});

	it("returns the option as given, one box per option", async () => {
		const s = setup();
		s.onPoll(1, s.tick("green light"));
		await expect(s.ui.select("Color", ["red", "green\n light"])).resolves.toBe(
			"green\n light",
		);
		expect(s.gh.posted[0]).toContain("- [ ] red\n- [ ] green light");
		expect(s.gh.bodies.get(1001)).toContain("✅ Answered: green light");
	});

	it("asks nothing without options", async () => {
		const s = setup();
		await expect(s.ui.select("Color", [])).resolves.toBeUndefined();
		expect(s.gh.posted).toHaveLength(0);
	});

	it("continues without an answer at the timeout", async () => {
		const s = setup({ timeoutMs: 30 });
		await expect(s.ui.confirm("Deploy?", "Ship it?")).resolves.toBe(false);
		await expect(s.ui.select("Color", ["red"])).resolves.toBeUndefined();
		expect(s.gh.bodies.get(1001)).toContain(
			"No answer within 1 second; pi continued without one.",
		);
		expect(s.gh.bodies.get(1002)).toContain("No answer within");
	});

	it("stops waiting when the signal aborts", async () => {
		const s = setup();
		const controller = new AbortController();
		s.onPoll(1, (body) => {
			controller.abort();
			return body;
		});
		await expect(
			s.ui.confirm("Deploy?", "Ship it?", { signal: controller.signal }),
		).resolves.toBe(false);
		expect(s.gh.bodies.get(1001)).toContain("pi stopped waiting");

		await expect(
			s.ui.select("Color", ["red"], { signal: controller.signal }),
		).resolves.toBeUndefined();
		await expect(
			s.ui.input("Name?", undefined, { signal: controller.signal }),
		).resolves.toBeUndefined();
		expect(s.gh.posted).toHaveLength(1); // nothing asked once aborted
	});

	it("ignores and restores a question someone rewrote", async () => {
		const s = setup();
		s.onPoll(1, () => "- [x] Yes\n- [ ] No");
		await expect(s.ui.confirm("Deploy?", "Ship it?")).resolves.toBe(false);
		const restored = String(s.gh.bodies.get(1001));
		expect(restored).toContain("<!-- pi-action:question q1 -->");
		expect(restored).toContain("edited beyond its checkboxes");
		expect(s.log.warning).toHaveBeenCalledWith(
			expect.stringContaining("was edited beyond its checkboxes"),
		);
	});

	it("keeps polling when a check fails, and warns when the comment can't be updated", async () => {
		const s = setup();
		s.onPoll(2, s.tick("Yes"));
		vi.mocked(s.gh.getComment).mockRejectedValueOnce(new Error("502"));
		vi.mocked(s.gh.updateComment).mockRejectedValueOnce(new Error("403"));
		await expect(s.ui.confirm("Deploy?", "Ship it?")).resolves.toBe(true);
		expect(s.log.warning).toHaveBeenCalledWith(
			"Could not check for an answer: 502",
		);
		expect(s.log.warning).toHaveBeenCalledWith(
			"Could not update the question comment: 403",
		);
	});
});

describe("createGitHubUi: input", () => {
	const reply = (id: number, body: string, association = "MEMBER") =>
		createComment({
			id,
			body,
			author_association: association,
			created_at: new Date().toISOString(),
			html_url: `https://github.com/o/r/issues/42#issuecomment-${id}`,
		});

	it("takes the first /answer reply from someone allowed to run pi", async () => {
		const s = setup();
		s.comments.push(
			reply(500, "/answer from before the question"),
			reply(2001, "/answer evil", "NONE"),
			reply(2002, "not an answer"),
			reply(2003, "/answer  release-2.1 "),
		);

		await expect(s.ui.input("Branch?", "main")).resolves.toBe("release-2.1");

		expect(s.gh.posted[0]).toContain("For example: `/answer main`");
		expect(s.gh.posted[0]).toContain("starts with `/answer`");
		expect(s.gh.bodies.get(1001)).toContain(
			"✅ Answered by @user** (https://github.com/o/r/issues/42#issuecomment-2003)",
		);
		expect(s.gh.addReaction).toHaveBeenCalledWith(
			{ source: "comment", issueNumber: 42, commentId: 2003 },
			"+1",
		);
		expect(s.log.info).toHaveBeenCalledWith(
			"Ignoring /answer from @user, who is not allowed to run pi",
		);
	});

	it("uses each reply for one question only, and times out without one", async () => {
		const s = setup({ timeoutMs: 40 });
		s.comments.push(reply(2001, "/answer first"));
		vi.mocked(s.gh.addReaction).mockRejectedValueOnce(new Error("nope"));
		await expect(s.ui.input("One?")).resolves.toBe("first");
		await expect(s.ui.input("Two?")).resolves.toBeUndefined();
		expect(s.gh.posted[1]).not.toContain("For example");
		expect(s.gh.bodies.get(1002)).toContain("No answer within");
		expect(s.log.warning).toHaveBeenCalledWith(
			"Could not react to the answer: nope",
		);
	});
});

describe("createGitHubUi: notify", () => {
	it("logs and adds to the job summary, not to comments", async () => {
		const s = setup();
		s.ui.notify("saved");
		s.ui.notify("careful", "warning");
		s.summary.mockRejectedValueOnce(new Error("no summary file"));
		s.ui.notify("broke\ndown", "error");
		await vi.waitFor(() => {
			expect(s.log.warning).toHaveBeenCalledWith(
				"Could not write the job summary: no summary file",
			);
		});
		expect(s.log.info).toHaveBeenCalledWith("pi: saved");
		expect(s.log.warning).toHaveBeenCalledWith("pi (warning): careful");
		expect(s.log.warning).toHaveBeenCalledWith("pi (error): broke\ndown");
		expect(s.summary.mock.calls.map(([markdown]) => markdown)).toStrictEqual([
			"### pi notifications\n\n- ℹ️ saved\n",
			"- ⚠️ careful\n",
			"- ❌ broke down\n",
		]);
		expect(s.gh.posted).toHaveLength(0);
	});
});
