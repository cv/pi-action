import {
	getInput,
	info,
	error as logError,
	setFailed,
	setOutput,
	summary,
	warning,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createGitHubClient } from "./github.ts";
import { readActionInputs } from "./inputs.ts";
import { run } from "./run.ts";
import { getErrorMessage } from "./utils.ts";

run({
	inputs: readActionInputs(getInput),
	payload: context.payload,
	createClient: (token: string) =>
		createGitHubClient(getOctokit(token), {
			owner: context.repo.owner,
			name: context.repo.repo,
		}),
	log: { info, warning, error: logError, setFailed, setOutput },
	cwd: process.cwd(),
	summary: async (markdown) => {
		await summary.addRaw(markdown).write();
	},
}).catch((caughtError: unknown) => {
	setFailed(getErrorMessage(caughtError));
});
