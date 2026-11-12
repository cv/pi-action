// The action's `if: always()` step: save the working tree once more, and push the thread ref (with the working-tree
// snapshots) if the main step left commits unpushed (cancelled, timed out, or crashed). Pushes are fast-forward only,
// so this never overwrites another run's history.
import { info, warning } from "@actions/core";
import { context } from "@actions/github";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

import { isForkPullRequest } from "./github.ts";
import {
	parsePositiveInteger,
	readWorktreeLimits,
	readWorktreeSnapshots,
} from "./inputs.ts";
import { GitStorage } from "./storage/git-storage.ts";
import { git } from "./storage/git.ts";
import { GitSync } from "./storage/sync.ts";
import { type SnapshotLimits, worktreeRef } from "./storage/worktree.ts";
import { threadRef } from "./thread.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";
import { WorktreeContinuity } from "./worktree.ts";

const ISSUE_KEY = "issue";
const PULL_REQUEST_KEY = "pull_request";
const PR_NUMBER_ENV = "INPUT_PR_NUMBER";

function threadNumber(payload: Record<string, unknown>): number | undefined {
	const subject: unknown = payload[ISSUE_KEY] ?? payload[PULL_REQUEST_KEY];
	const number: unknown =
		typeof subject === "object" && subject !== null
			? Reflect.get(subject, "number")
			: undefined;
	return typeof number === "number" ? number : undefined;
}

/** An action input, as the step's `env:` passes it. */
const envInput = (name: string): string =>
	process.env[`INPUT_${name.toUpperCase()}`] ?? "";

const localTip = async (
	cwd: string,
	ref: string,
): Promise<string | undefined> =>
	(
		await git(cwd, ["rev-parse", "--verify", "-q", ref]).catch(() => "")
	).trim() || undefined;

/**
 * Save the working tree as the main step left it, if it differs from the snapshot the thread points at: open the
 * thread (without resuming any of its work), record the snapshot, and point the conversation at it.
 */
async function saveWorktree(
	cwd: string,
	issueNumber: number,
	limits: SnapshotLimits,
	log: Log,
): Promise<void> {
	const storage = await GitStorage.open({
		repo: cwd,
		ref: threadRef(issueNumber),
		author: {
			name: "pi-action",
			email: "pi-action@users.noreply.github.com",
		},
	});
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		const worktree = new WorktreeContinuity({
			cwd,
			ref: worktreeRef(issueNumber),
			limits,
			log,
		});
		worktree.attach(harness, await harness.root(BACKGROUND_CONTEXT));
		await worktree.resumeFrom();
		await worktree.checkpoint(storage.tip);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

export async function pushThread(
	payload: Record<string, unknown>,
	cwd: string,
	log: Log,
	prNumber?: number,
	/** Save the working tree with these limits first; undefined: working-tree snapshots are off. */
	worktree?: SnapshotLimits,
): Promise<"pushed" | "up-to-date" | "nothing" | "failed"> {
	// The main step works on pr_number's thread when it is set, whatever the event.
	const number = prNumber ?? threadNumber(payload);
	if (number === undefined) {
		return "nothing";
	}
	const ref = threadRef(number);
	if ((await localTip(cwd, ref)) === undefined) {
		log.info(`${ref}: nothing to push`);
		return "nothing";
	}
	if (worktree !== undefined) {
		await saveWorktree(cwd, number, worktree, log).catch((error: unknown) => {
			log.warning(`Could not save the working tree: ${getErrorMessage(error)}`);
		});
	}
	const companionRef = worktree === undefined ? undefined : worktreeRef(number);
	try {
		const tip = (await localTip(cwd, ref)) ?? "";
		const companion =
			companionRef === undefined
				? undefined
				: await localTip(cwd, companionRef);
		const sync = new GitSync({ repo: cwd, ref, companionRef, log: log.info });
		const remote = await sync.remoteHeads();
		if (
			remote.tip === tip &&
			(companion === undefined || remote.companion === companion)
		) {
			log.info(`${ref} is already saved at ${tip.slice(0, 7)}`);
			return "up-to-date";
		}
		await sync.flush(tip, companion);
		log.info(`${ref} is saved at ${tip.slice(0, 7)}`);
		return "pushed";
	} catch (error) {
		log.warning(`Could not push ${ref}: ${getErrorMessage(error)}`);
		return "failed";
	}
}

if (process.argv[1]?.endsWith("push.ts") === true) {
	const snapshots =
		readWorktreeSnapshots(envInput) && !isForkPullRequest(context.payload);
	pushThread(
		context.payload,
		process.cwd(),
		{ info, warning },
		parsePositiveInteger(process.env[PR_NUMBER_ENV] ?? ""),
		snapshots ? readWorktreeLimits(envInput) : undefined,
	).catch((error: unknown) => {
		warning(getErrorMessage(error));
	});
}
