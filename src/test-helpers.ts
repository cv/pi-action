// Shared fixtures: inputs, a fake GitHub, faux models, and scratch git repositories.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { onTestFinished, vi } from "vitest";

import { DEFAULTS } from "./defaults.ts";
import type { GitHubClient } from "./github.ts";
import type { ActionInputs } from "./inputs.ts";
import type { Logger } from "./run.ts";
import type { GitHubComment, TriggerInfo } from "./types.ts";

/** A Logger whose methods are typed mocks. */
export function createLogger(): Logger {
	return {
		info: vi.fn<Logger["info"]>(),
		warning: vi.fn<Logger["warning"]>(),
		error: vi.fn<Logger["error"]>(),
		setFailed: vi.fn<Logger["setFailed"]>(),
		setOutput: vi.fn<Logger["setOutput"]>(),
	};
}

const since = (list: GitHubComment[], iso?: string) =>
	iso
		? list.filter((c) => Date.parse(c.created_at) >= Date.parse(iso))
		: [...list];

/**
 * A mock GitHub client. `comments` and `reviewComments` back the list methods (live arrays: tests may push to
 * them), and posted comment bodies are recorded in `posted`.
 */
export function createMockGitHubClient(
	comments: GitHubComment[] = [],
	reviewComments: GitHubComment[] = [],
): GitHubClient & { posted: string[] } {
	const posted: string[] = [];
	return {
		posted,
		addReaction: vi.fn(),
		createComment: vi.fn(async (_issue: number, body: string) => {
			posted.push(body);
			return {
				id: 1000 + posted.length,
				url: `https://github.com/o/r/issues/1#c${posted.length}`,
			};
		}),
		getPullRequest: vi
			.fn()
			.mockResolvedValue({ number: 1, title: "Test PR", body: "PR body" }),
		getPullRequestDiff: vi.fn().mockResolvedValue(""),
		listIssueComments: vi.fn(async (_issue: number, iso?: string) =>
			since(comments, iso),
		),
		listReviewComments: vi.fn(async (_pr: number, iso?: string) =>
			since(reviewComments, iso),
		),
	};
}

export function createComment(
	overrides: Partial<GitHubComment> = {},
): GitHubComment {
	return {
		id: 1,
		body: "@pi do something",
		user: { login: "user", type: "User" },
		author_association: "MEMBER",
		created_at: "2026-01-01T00:00:00Z",
		html_url: "https://github.com/o/r/issues/1#issuecomment-1",
		...overrides,
	};
}

export function createTriggerInfo(
	overrides: Partial<TriggerInfo> = {},
): TriggerInfo {
	return {
		triggerText: "@pi test",
		author: { login: "user", type: "User" },
		authorAssociation: "OWNER",
		issueNumber: 1,
		issueTitle: "Test",
		issueBody: "Body",
		isPullRequest: false,
		source: "body",
		...overrides,
	};
}

export function createActionInputs(
	overrides: Partial<ActionInputs> = {},
): ActionInputs {
	return {
		triggerPhrase: DEFAULTS.triggerPhrase,
		allowedBots: [],
		allowedUsers: [],
		allowedAssociations: [...DEFAULTS.allowedAssociations],
		provider: DEFAULTS.provider,
		model: DEFAULTS.model,
		timeout: DEFAULTS.timeout,
		githubToken: "test-token",
		apiKey: undefined,
		customProvider: undefined,
		promptTemplate: undefined,
		outputMode: DEFAULTS.outputMode,
		prompt: undefined,
		prNumber: undefined,
		pollInterval: DEFAULTS.pollInterval,
		...overrides,
	};
}

/** A faux provider in a fresh model registry, and the pi-durable agent config that uses its model. */
export function fauxModels(): {
	faux: ReturnType<typeof fauxProvider>;
	models: ReturnType<typeof createModels>;
	model: Model<Api>;
	agent: { model: { provider: string; modelId: string } };
} {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	return {
		faux,
		models,
		model,
		agent: { model: { provider: model.provider, modelId: model.id } },
	};
}

/** Run git in `cwd` and return its output. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A temp directory, removed when the current test finishes. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

/** A fresh, empty git repository. */
export function tempRepo(): {
	dir: string;
	git: (...args: string[]) => string;
} {
	const dir = tempDir("git-pi-durable-");
	git(dir, "init", "-q", "-b", "main");
	return { dir, git: (...args) => git(dir, ...args) };
}

/** A bare "GitHub" remote with one commit on main, and a way to make fresh clones of it (runner checkouts). */
export function tempRemote(): {
	remote: string;
	clone: (...flags: string[]) => string;
} {
	const root = tempDir("pi-action-remote-");
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	git(root, "init", "-q", "--bare", "-b", "main", remote);
	git(root, "init", "-q", "-b", "main", seed);
	git(seed, "commit", "-q", "--allow-empty", "-m", "init");
	git(seed, "push", "-q", remote, "main");
	let clones = 0;
	return {
		remote,
		clone: (...flags) => {
			clones += 1;
			const dir = join(root, `clone-${clones}`);
			git(root, "clone", "-q", ...flags, `file://${remote}`, dir);
			return dir;
		},
	};
}
