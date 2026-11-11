import {
	getInput,
	info,
	error as logError,
	setFailed,
	setOutput,
	warning,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { readActionInputs } from "./action-inputs.ts";
import { createGitHubClient } from "./github.ts";
import { run } from "./run.ts";
import { getErrorMessage } from "./utils.ts";

run({
	inputs: readActionInputs(getInput),
	context: {
		payload: context.payload,
		repo: {
			owner: context.repo.owner,
			name: context.repo.repo,
		},
	},
	createClient: (token: string) =>
		createGitHubClient(getOctokit(token), {
			repo: {
				owner: context.repo.owner,
				name: context.repo.repo,
			},
		}),
	log: {
		info,
		warning,
		error: logError,
		setFailed,
		setOutput,
	},
	cwd: process.cwd(),
}).catch((caughtError) => {
	setFailed(getErrorMessage(caughtError));
});
