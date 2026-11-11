// The action's `if: always()` step: push the thread ref if the main step left commits unpushed (cancelled,
// timed out, or crashed). Pushes are fast-forward only, so this never overwrites another run's history.
import { info, warning } from "@actions/core";
import { context } from "@actions/github";
import { GitSync, runGit } from "./storage/sync.ts";
import { threadRef } from "./thread.ts";
import { getErrorMessage } from "./utils.ts";

const ISSUE_KEY = "issue";
const PULL_REQUEST_KEY = "pull_request";
const PR_NUMBER_ENV = "INPUT_PR_NUMBER";

interface PushLogger {
	info: (msg: string) => void;
	warning: (msg: string) => void;
}

function threadNumber(payload: Record<string, unknown>): number | undefined {
	const subject = (payload[ISSUE_KEY] ?? payload[PULL_REQUEST_KEY]) as
		| { number?: unknown }
		| undefined;
	return typeof subject?.number === "number" ? subject.number : undefined;
}

export async function pushThread(
	payload: Record<string, unknown>,
	cwd: string,
	log: PushLogger,
	prNumber?: number,
): Promise<"pushed" | "up-to-date" | "nothing" | "failed"> {
	const number = threadNumber(payload) ?? prNumber;
	if (number === undefined) {
		return "nothing";
	}
	const ref = threadRef(number);
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
		const sync = new GitSync({ repo: cwd, ref, log: log.info });
		if ((await sync.remoteHead()) === tip) {
			log.info(`${ref} is already saved at ${tip.slice(0, 7)}`);
			return "up-to-date";
		}
		await sync.flush(tip);
		log.info(`${ref} is saved at ${tip.slice(0, 7)}`);
		return "pushed";
	} catch (error) {
		log.warning(`Could not push ${ref}: ${getErrorMessage(error)}`);
		return "failed";
	}
}

const dispatchedPr = Number.parseInt(process.env[PR_NUMBER_ENV] ?? "", 10);
if (process.argv[1]?.endsWith("push.ts")) {
	pushThread(
		context.payload,
		process.cwd(),
		{ info, warning },
		Number.isNaN(dispatchedPr) ? undefined : dispatchedPr,
	).catch((error: unknown) => warning(getErrorMessage(error)));
}
