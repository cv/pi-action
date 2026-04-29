import * as core from "@actions/core";
import * as github from "@actions/github";
import { readActionInputs } from "./action-inputs.js";
import { createGitHubClient } from "./github.js";
import { run } from "./run.js";
import { getErrorMessage } from "./utils.js";

run({
	inputs: readActionInputs(core.getInput),
	context: {
		payload: github.context.payload,
		repo: {
			owner: github.context.repo.owner,
			name: github.context.repo.repo,
		},
	},
	createClient: (token: string) =>
		createGitHubClient(github.getOctokit(token), {
			repo: {
				owner: github.context.repo.owner,
				name: github.context.repo.repo,
			},
		}),
	log: {
		info: core.info,
		warning: core.warning,
		error: core.error,
		setFailed: core.setFailed,
		setOutput: core.setOutput,
	},
	cwd: process.cwd(),
}).catch((error) => {
	core.setFailed(getErrorMessage(error));
});
