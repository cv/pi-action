import { describe, expect, it, vi } from "vitest";

import { answerFromEvent, questionEventKind } from "./answers.ts";
import { answeredBody, parseQuestion, renderQuestion } from "./github-ui.ts";
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
	message: "Ship it?",
};
const SELECT: UiQuestion = {
	kind: "select",
	key: "fedcba9876543210",
	title: "Color",
	options: ["red", "green"],
};
const branch: UiQuestion = {
	kind: "input",
	key: "1111111111111111",
	title: "Branch?",
};
const tag: UiQuestion = {
	kind: "input",
	key: "2222222222222222",
	title: "Tag?",
};
const ADA = { login: "ada", type: "User" };
const URL_1001 = "https://github.com/o/r/issues/42#issuecomment-1001";
const issue = {
	number: 42,
	title: "Ship",
	body: "please",
	user: { login: "o", type: "User" },
};
const tick = (body: string, label: string) =>
	body.replace(`- [ ] ${label}`, `- [x] ${label}`);

function setup(comments: GitHubComment[] = []) {
	const gh = createMockGitHubClient(comments);
	const log = createLogger();
	const allow = {
		allowedBots: [],
		allowedUsers: [],
		allowedAssociations: ["OWNER", "MEMBER"],
	};
	return { gh, log, allow, options: { gh, log, allow } };
}

/** The `edited` event of question comment 1001 going from `before` to `after`, by `sender`. */
function edited(
	before: string,
	after: string,
	sender: { login: string; type: string } = ADA,
) {
	return {
		action: "edited",
		issue,
		comment: {
			id: 1001,
			body: after,
			user: { login: "github-actions[bot]", type: "Bot" },
			author_association: "NONE",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-02T00:00:00Z",
			html_url: URL_1001,
		},
		changes: { body: { from: before } },
		sender,
	};
}

describe("answerFromEvent: a ticked box", () => {
	it("answers a confirm with the box ticked, by someone with write access", async () => {
		const s = setup();
		const before = renderQuestion(CONFIRM);
		const after = tick(before, "Yes");
		s.gh.bodies.set(1001, after);
		const event = await answerFromEvent(edited(before, after), s.options);
		expect(event?.trigger).toStrictEqual({
			key: `answer-${KEY}-1001`,
			source: "comment",
			issueNumber: 42,
			commentId: 1001,
			author: { login: "ada", type: "User" },
			text: `**@ada** answered pi's question *Deploy?* (${URL_1001}): Yes`,
			task: `**@ada** answered pi's question *Deploy?* (${URL_1001}): Yes`,
			createdAt: "2026-01-02T00:00:00Z",
			url: URL_1001,
			answer: {
				key: KEY,
				kind: "confirm",
				answer: true,
				by: "ada",
				url: URL_1001,
				title: "Deploy?",
			},
		});
		expect(event?.info).toMatchObject({
			issueNumber: 42,
			commentId: 1001,
			author: { login: "ada" },
		});
		expect(s.gh.getCollaboratorPermission).toHaveBeenCalledWith("ada");
		expect(s.gh.updateComment).toHaveBeenCalledWith(
			1001,
			answeredBody(after, "Yes", "ada"),
		);
	});

	it("answers a select with the option, and No as false", async () => {
		const s = setup();
		const before = tick(renderQuestion(SELECT), "red");
		const after = tick(before, "green");
		s.gh.bodies.set(1001, after);
		const event = await answerFromEvent(edited(before, after), s.options);
		expect(event?.trigger.answer).toMatchObject({
			kind: "select",
			answer: "green",
		});

		const no = renderQuestion(CONFIRM);
		s.gh.bodies.set(1001, tick(no, "No"));
		const declined = await answerFromEvent(
			edited(no, tick(no, "No")),
			s.options,
		);
		expect(declined?.trigger.answer?.answer).toBe(false);
	});

	it.each([
		{ role: "read", allowedUsers: [] },
		{ role: "triage", allowedUsers: [] },
		{ role: "write", allowedUsers: ["someone-else"] },
	])(
		"ignores a tick by a user who may not answer ($role, $allowedUsers)",
		async ({ role, allowedUsers }) => {
			const s = setup();
			vi.mocked(s.gh.getCollaboratorPermission).mockResolvedValue(role);
			const before = renderQuestion(CONFIRM);
			const after = tick(before, "Yes");
			s.gh.bodies.set(1001, after);
			await expect(
				answerFromEvent(edited(before, after), {
					...s.options,
					allow: { ...s.allow, allowedUsers },
				}),
			).resolves.toBeUndefined();
			expect(s.log.warning).toHaveBeenCalledWith(
				expect.stringContaining("@ada ticked a box"),
			);
			expect(s.gh.updateComment).not.toHaveBeenCalled();
		},
	);

	it("checks bots against allowed_bots, and treats a failed permission check as no access", async () => {
		const s = setup();
		const before = renderQuestion(CONFIRM);
		const after = tick(before, "Yes");
		s.gh.bodies.set(1001, after);
		const bot = { login: "helper[bot]", type: "Bot" };
		await expect(
			answerFromEvent(edited(before, after, bot), s.options),
		).resolves.toBeUndefined();
		const allowed = {
			...s.options,
			allow: { ...s.allow, allowedBots: ["helper[bot]"] },
		};
		await expect(
			answerFromEvent(edited(before, after, bot), allowed),
		).resolves.toBeDefined();

		s.gh.bodies.set(1001, after); // the allowed bot's answer marked it answered
		vi.mocked(s.gh.getCollaboratorPermission).mockRejectedValueOnce(
			new Error("403"),
		);
		await expect(
			answerFromEvent(edited(before, after), s.options),
		).resolves.toBeUndefined();
		expect(s.log.warning).toHaveBeenCalledWith(
			"Could not check @ada's permission: 403",
		);
	});

	it("ignores edits that answer nothing new", async () => {
		const s = setup();
		const open = renderQuestion(CONFIRM);
		const yes = tick(open, "Yes");
		s.gh.bodies.set(1001, yes);
		const cases = [
			edited(yes, open), // unticked
			edited(open, open.replace("Ship it?", "Ship it now?")), // no box
			edited(open, tick(open.replace("- [ ] No", "- [ ] Maybe"), "Yes")), // options changed
			edited(answeredBody(open, "No", "bob"), yes), // answered before the edit
			edited(renderQuestion(SELECT), yes), // another question
			edited("plain", yes),
		];
		const results = await Promise.all(
			cases.map(async (payload) => answerFromEvent(payload, s.options)),
		);
		expect(results).toStrictEqual(cases.map(() => undefined));
		expect(s.gh.updateComment).not.toHaveBeenCalled();
	});

	it("ignores a tick on a question another run already answered", async () => {
		const s = setup();
		const open = renderQuestion(CONFIRM);
		const yes = tick(open, "Yes");
		s.gh.bodies.set(1001, answeredBody(yes, "Yes", "bob"));
		const both = tick(yes, "No");
		await expect(
			answerFromEvent(edited(yes, both), s.options),
		).resolves.toBeUndefined();
		expect(s.log.info).toHaveBeenCalledWith(
			`The question ${URL_1001} is already answered; skipping`,
		);
	});

	it("still delivers the answer when the question can't be marked answered", async () => {
		const s = setup();
		const before = renderQuestion(CONFIRM);
		s.gh.bodies.set(1001, tick(before, "Yes"));
		vi.mocked(s.gh.updateComment).mockRejectedValueOnce(new Error("gone"));
		const after = tick(before, "Yes");
		await expect(
			answerFromEvent(edited(before, after), s.options),
		).resolves.toBeDefined();
		expect(s.log.warning).toHaveBeenCalledWith(
			"Could not mark the question answered: gone",
		);
	});
});

describe("answerFromEvent: an /answer reply", () => {
	const questions = (): GitHubComment[] => [
		createComment({
			id: 1001,
			body: renderQuestion(branch),
			html_url: URL_1001,
		}),
		createComment({
			id: 1002,
			body: renderQuestion(tag),
			html_url: "url-1002",
		}),
		createComment({
			id: 1003,
			body: answeredBody(renderQuestion(branch), "x", "y"),
			html_url: "url-1003",
		}),
	];
	const reply = (body: string, overrides: Record<string, unknown> = {}) => ({
		action: "created",
		issue,
		comment: {
			id: 2000,
			body,
			user: { login: "ada", type: "User" },
			author_association: "MEMBER",
			created_at: "2026-01-03T00:00:00Z",
			html_url: "url-2000",
			...overrides,
		},
		sender: { login: "ada", type: "User" },
	});

	it("answers the oldest open input question, reacts 👍, and marks it answered", async () => {
		const s = setup(questions());
		const event = await answerFromEvent(
			reply("/answer release-2.1"),
			s.options,
		);
		expect(event?.trigger).toMatchObject({
			key: "answer-1111111111111111-1001",
			commentId: 2000,
			createdAt: "2026-01-03T00:00:00Z",
			text: `**@ada** answered pi's question *Branch?* (${URL_1001}): release-2.1`,
			answer: {
				kind: "input",
				answer: "release-2.1",
				by: "ada",
				url: URL_1001,
			},
		});
		expect(s.gh.addReaction).toHaveBeenCalledWith(
			{ source: "comment", issueNumber: 42, commentId: 2000 },
			"+1",
		);
		const [[, body] = [0, ""]] = vi.mocked(s.gh.updateComment).mock.calls;
		expect(parseQuestion(body)?.answered).toBe(true);
	});

	it("answers the question the reply quotes", async () => {
		const s = setup(questions());
		vi.mocked(s.gh.addReaction).mockRejectedValueOnce(new Error("no"));
		const event = await answerFromEvent(
			reply("> ### ❓ Tag?\n\n/answer v2"),
			s.options,
		);
		expect(event?.trigger.answer).toMatchObject({
			key: tag.key,
			answer: "v2",
			url: "url-1002",
		});
		expect(s.log.warning).toHaveBeenCalledWith(
			"Could not react to the answer: no",
		);
	});

	it("ignores replies from people who may not run pi, and replies no question waits for", async () => {
		const s = setup(questions());
		await expect(
			answerFromEvent(
				reply("/answer x", { author_association: "NONE" }),
				s.options,
			),
		).resolves.toBeUndefined();
		expect(s.log.warning).toHaveBeenCalledWith(
			"Ignoring /answer from @ada, who is not allowed to run pi",
		);
		await expect(
			answerFromEvent(reply("/answer x", { id: 1000 }), s.options),
		).resolves.toBeUndefined();
		expect(s.log.info).toHaveBeenCalledWith(
			"An /answer reply, but no question is waiting for one; skipping",
		);
		expect(s.gh.updateComment).not.toHaveBeenCalled();
	});
});

describe("questionEventKind", () => {
	it("tells question edits and /answer replies from other events", () => {
		const open = renderQuestion(CONFIRM);
		expect(questionEventKind(edited(open, open))).toBe("edit");
		expect(
			questionEventKind({ ...edited(open, open), action: "created" }),
		).toBeUndefined();
		expect(
			questionEventKind({
				action: "created",
				issue,
				comment: { body: "/answer x" },
			}),
		).toBe("reply");
		expect(
			questionEventKind({
				action: "edited",
				issue,
				comment: { body: "/answer x" },
			}),
		).toBeUndefined();
		expect(
			questionEventKind({
				action: "created",
				issue,
				comment: { body: "@pi hi" },
			}),
		).toBeUndefined();
		expect(
			questionEventKind({ action: "edited", comment: { body: open } }),
		).toBeUndefined();
		expect(questionEventKind({ action: "opened", issue })).toBeUndefined();
	});
});
