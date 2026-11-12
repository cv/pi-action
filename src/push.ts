// The action's `if: always()` step: push the thread ref (with its working-tree snapshots) if the main step left
// commits unpushed (cancelled, timed out, or crashed). Pushes are fast-forward only, so this never overwrites another run's history.
import { info, warning } from "@actions/core";
import { context } from "@actions/github";

import { parsePositiveInteger } from "./inputs.ts";
import { git } from "./storage/git.ts";
import { GitSync, liveRef } from "./storage/sync.ts";
import { worktreeRef } from "./storage/worktree.ts";
import { threadRef } from "./thread.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

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

/** Whether the remote's `remoteTip` already has `tip` in its history (the main step pushed past it). */
async function contains(
	cwd: string,
	remoteTip: string | undefined,
	tip: string,
): Promise<boolean> {
	if (remoteTip === undefined) {
		return false;
	}
	// A remote tip this clone doesn't have is not one it pushed: an error, so false.
	return git(cwd, ["merge-base", "--is-ancestor", tip, remoteTip]).then(
		() => true,
		() => false,
	);
}

export async function pushThread(
	payload: Record<string, unknown>,
	cwd: string,
	log: Log,
	prNumber?: number,
): Promise<"pushed" | "up-to-date" | "nothing" | "failed"> {
	// The main step works on pr_number's thread when it is set, whatever the event.
	const number = prNumber ?? threadNumber(payload);
	if (number === undefined) {
		return "nothing";
	}
	const ref = threadRef(number);
	// The main step keeps the refs it works on outside refs/pi/ (see liveRef()).
	const localRef = liveRef(ref);
	let tip: string;
	try {
		tip = (await git(cwd, ["rev-parse", "--verify", "-q", localRef])).trim();
	} catch {
		log.info(`${ref}: nothing to push`);
		return "nothing";
	}
	// The working-tree snapshots, when the main step saved any.
	const companionRef = worktreeRef(number);
	const localCompanionRef = liveRef(companionRef);
	const companion = (
		await git(cwd, ["rev-parse", "--verify", "-q", localCompanionRef]).catch(
			() => "",
		)
	).trim();
	try {
		const sync = new GitSync({
			repo: cwd,
			ref,
			localRef,
			companionRef,
			localCompanionRef,
			log: log.info,
		});
		const remote = await sync.remoteHeads();
		if (
			(remote.tip === tip || (await contains(cwd, remote.tip, tip))) &&
			(companion === "" ||
				remote.companion === companion ||
				(await contains(cwd, remote.companion, companion)))
		) {
			log.info(
				`${ref} is already saved at ${(remote.tip ?? tip).slice(0, 7)}`,
			);
			return "up-to-date";
		}
		await sync.flush(tip, companion || undefined);
		log.info(`${ref} is saved at ${tip.slice(0, 7)}`);
		return "pushed";
	} catch (error) {
		log.warning(`Could not push ${ref}: ${getErrorMessage(error)}`);
		return "failed";
	}
}

if (process.argv[1]?.endsWith("push.ts") === true) {
	pushThread(
		context.payload,
		process.cwd(),
		{ info, warning },
		parsePositiveInteger(process.env[PR_NUMBER_ENV] ?? ""),
	).catch((error: unknown) => {
		warning(getErrorMessage(error));
	});
}
