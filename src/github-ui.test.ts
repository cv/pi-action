import { describe, expect, it, vi } from "vitest";

import {
	answeredBody,
	createGitHubUi,
	isQuestionComment,
	parseQuestion,
	readAnswerReply,
	renderQuestion,
} from "./github-ui.ts";
import {
	createComment,
	createLogger,
	createMockGitHubClient,
} from "./test-helpers.ts";
import type { GitHubComment, UiQuestion } from "./types.ts";

const KEY = "0123456789abcdef";
const CONFIRM: UiQuestion = {
	kind: "confirm",
	key: KEY,
	title: "Deploy?",
	message: "Ship it?\n- [ ] not a box",
};
const SELECT: UiQuestion = {
	kind: "select",
	key: "fedcba9876543210",
	title: "Color",
	options: ["red", "dark\ngreen", ""],
};
const INPUT: UiQuestion = {
	kind: "input",
	key: "00112233445566778899",
	title: "Branch?",
	placeholder: "release-2.1",
};

describe("question comments", () => {
	it("renders confirm and select as task lists, with the key and kind in the marker", () => {
		expect(renderQuestion(CONFIRM)).toBe(
			[
				`<!-- pi-action:question ${KEY} confirm -->`,
				"### ❓ Deploy?",
				"",
				"> Ship it?",
				"> - [ ] not a box",
				"",
				"- [ ] Yes",
				"- [ ] No",
				"",
				"<sub>Tick one box to answer. pi continues in a new run when you do; this run has ended.</sub>",
			].join("\n"),
		);
		const select = parseQuestion(renderQuestion(SELECT));
		expect(select).toStrictEqual({
			key: SELECT.key,
			kind: "select",
			title: "Color",
			options: ["red", "dark green", "(empty)"],
			ticked: [false, false, false],
			answered: false,
		});
	});

	it("renders input as a request for an /answer reply", () => {
		const body = renderQuestion(INPUT);
		expect(body).toContain("For example: `/answer release-2.1`");
		expect(body).toContain("Reply with a comment that starts with `/answer`");
		expect(parseQuestion(body)).toMatchObject({ kind: "input", options: [] });
		expect(
			renderQuestion({ ...INPUT, title: " ", placeholder: " " }),
		).toContain("### ❓ pi has a question\n\n\n<sub>");
	});

	it("reads ticked boxes, and marks a question answered", () => {
		const body = renderQuestion(CONFIRM).replace("- [ ] No", "- [X] No");
		// The message's "- [ ] not a box" is quoted, so it is no checkbox.
		expect(parseQuestion(body)?.ticked).toStrictEqual([false, true]);
		const answered = answeredBody(body, "No", "ada");
		expect(answered).not.toContain("<sub>");
		expect(answered).toContain("**✅ Answered: No by @ada**");
		expect(parseQuestion(answered)?.answered).toBe(true);
		expect(answeredBody(body, " ", "ada")).toContain("Answered: (empty) by");
	});

	it("is undefined for other comments and bad markers", () => {
		expect(parseQuestion("hello")).toBeUndefined();
		expect(
			parseQuestion("<!-- pi-action:question KEY confirm -->"),
		).toBeUndefined();
		expect(
			parseQuestion(`<!-- pi-action:question ${KEY} other -->`),
		).toBeUndefined();
		expect(
			parseQuestion(`text\n<!-- pi-action:question ${KEY} confirm -->`),
		).toBeUndefined();
		expect(
			parseQuestion(`<!-- pi-action:question ${KEY} confirm -->`)?.title,
		).toBe("pi has a question");
	});

	it("reads /answer replies, also after a quote", () => {
		expect(readAnswerReply("/answer release-2.1")).toStrictEqual({
			text: "release-2.1",
			quote: "",
		});
		expect(
			readAnswerReply("> ### ❓ Branch?\n> more\n\n/ANSWER  main <!-- x -->"),
		).toStrictEqual({
			text: "main",
			quote: "### ❓ Branch?\nmore",
		});
		expect(readAnswerReply("/answer")).toStrictEqual({ text: "", quote: "" });
		expect(readAnswerReply("/answers no")).toBeUndefined();
		expect(readAnswerReply("> /answer quoted only")).toBeUndefined();
		expect(readAnswerReply("please /answer")).toBeUndefined();
	});

	it("never takes questions or /answer replies for @pi requests", () => {
		expect(isQuestionComment(renderQuestion(CONFIRM))).toBe(true);
		expect(isQuestionComment("/answer @pi yes")).toBe(true);
		expect(isQuestionComment("@pi do it")).toBe(false);
	});
});

function setup() {
	const comments: GitHubComment[] = [];
	const gh = createMockGitHubClient(comments);
	const log = createLogger();
	const summary = vi.fn(async (_markdown: string) => undefined);
	const ui = createGitHubUi({ gh, issueNumber: 42, log, summary });
	return { gh, log, summary, ui, comments };
}

describe("createGitHubUi: ask", () => {
	it("posts the question and returns its URL at once", async () => {
		const s = setup();
		await expect(s.ui.ask(CONFIRM)).resolves.toStrictEqual({
			url: "https://github.com/o/r/issues/1#c1",
		});
		await s.ui.ask(INPUT);
		expect(s.gh.posted).toStrictEqual([
			renderQuestion(CONFIRM),
			renderQuestion(INPUT),
		]);
		expect(s.ui.asked).toStrictEqual([
			"https://github.com/o/r/issues/1#c1",
			"https://github.com/o/r/issues/1#c2",
		]);
		expect(s.log.info).toHaveBeenCalledWith(
			"Asked on GitHub: Deploy? (https://github.com/o/r/issues/1#c1)",
		);
		expect(s.gh.getComment).not.toHaveBeenCalled();
	});

	it("does not post a question that is still open again", async () => {
		const s = setup();
		const answered = answeredBody(renderQuestion(CONFIRM), "Yes", "ada");
		s.comments.push(
			createComment({
				id: 5,
				body: answered,
				html_url: "old",
			}),
			createComment({ id: 6, body: renderQuestion(CONFIRM), html_url: "open" }),
		);
		await expect(s.ui.ask(CONFIRM)).resolves.toStrictEqual({ url: "open" });
		expect(s.gh.posted).toHaveLength(0);
		expect(s.ui.asked).toStrictEqual(["open"]);
		// Answered before: asked anew.
		s.comments.pop();
		await expect(s.ui.ask(CONFIRM)).resolves.toStrictEqual({
			url: "https://github.com/o/r/issues/1#c1",
		});
	});

	it("refuses keys that could break the marker, and selects without options", async () => {
		const s = setup();
		await expect(s.ui.ask({ ...CONFIRM, key: "x -->" })).rejects.toThrow(
			"Invalid question key",
		);
		await expect(s.ui.ask({ ...SELECT, options: [] })).rejects.toThrow(
			"has no options",
		);
		expect(s.gh.posted).toHaveLength(0);
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
