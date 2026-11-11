// The action's `if: always()` step: push the thread ref if the main step left commits unpushed (cancelled,
// timed out, or crashed). Pushes are fast-forward only, so this never overwrites another run's history.
import * as core from "@actions/core";
import * as github from "@actions/github";
import { GitSync, runGit } from "./storage/sync.js";
import { threadRef } from "./thread.js";
import { getErrorMessage } from "./utils.js";

export async function pushThread(
	payload: Record<string, unknown>,
	cwd: string,
	log: { info: (m: string) => void; warning: (m: string) => void },
	remote?: string,
): Promise<"pushed" | "nothing" | "failed"> {
	const issue = (payload.issue ?? payload.pull_request) as
		| { number?: number }
		| undefined;
	if (typeof issue?.number !== "number") {
		return "nothing";
	}
	const ref = threadRef(issue.number);
	let tip: string;
	try {
		tip = (
			await runGit(["rev-parse", "--verify", "-q", ref], cwd)
		).stdout.trim();
	} catch {
		log.info(`${ref}: nothing to push`);
		return "nothing";
	}
	try {
		await new GitSync({ repo: cwd, ref, remote, log: log.info }).flush(tip);
		log.info(`${ref} is saved at ${tip.slice(0, 7)}`);
		return "pushed";
	} catch (error) {
		log.warning(`Could not push ${ref}: ${getErrorMessage(error)}`);
		return "failed";
	}
}

if (
	process.env.GITHUB_ACTIONS === "true" &&
	process.argv[1]?.endsWith("push.js")
) {
	pushThread(github.context.payload, process.cwd(), core).catch((error) =>
		core.warning(getErrorMessage(error)),
	);
}
