import {
	debug,
	getInput,
	endGroup,
	info,
	error as logError,
	setFailed,
	setOutput,
	startGroup,
	summary,
	warning,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createGitHubClient } from "./github.ts";
import { readActionInputs } from "./inputs.ts";
import { run } from "./run.ts";
import { getErrorMessage } from "./utils.ts";

// An invalid input (such as thinking_level) throws in readActionInputs; the catch fails the step with its message.
Promise.resolve()
	.then(async () =>
		run({
			inputs: readActionInputs(getInput),
			payload: context.payload,
			createClient: (token: string) =>
				createGitHubClient(getOctokit(token), {
					owner: context.repo.owner,
					name: context.repo.repo,
				}),
			log: {
				info,
				debug,
				warning,
				error: logError,
				setFailed,
				setOutput,
				startGroup,
				endGroup,
			},
			cwd: process.cwd(),
			summary: async (markdown) => {
				await summary.addRaw(markdown).write();
			},
		}),
	)
	.catch((caughtError: unknown) => {
		setFailed(getErrorMessage(caughtError));
	});
