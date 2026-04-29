import * as core from "@actions/core";
import * as github from "@actions/github";
import { DEFAULTS } from "./defaults.js";
import { createGitHubClient } from "./github.js";
import { getInputOrDefault, parseBooleanInput, parseCsvInput, parsePositiveIntegerInput, } from "./inputs.js";
import { run } from "./run.js";
import { getErrorMessage } from "./utils.js";
run({
    inputs: {
        triggerPhrase: getInputOrDefault(core.getInput, "trigger_phrase", DEFAULTS.triggerPhrase),
        allowedBots: parseCsvInput(core.getInput("allowed_bots")),
        modelConfig: {
            timeout: parsePositiveIntegerInput(core.getInput("timeout"), DEFAULTS.timeout),
            provider: getInputOrDefault(core.getInput, "provider", DEFAULTS.provider),
            model: getInputOrDefault(core.getInput, "model", DEFAULTS.model),
        },
        githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
        gistToken: core.getInput("gist_token") || undefined,
        piAuthJson: core.getInput("pi_auth_json"),
        promptTemplate: core.getInput("prompt_template"),
        shareSession: parseBooleanInput(core.getInput("share_session"), DEFAULTS.shareSession),
    },
    context: {
        payload: github.context.payload,
        repo: {
            owner: github.context.repo.owner,
            name: github.context.repo.repo,
        },
    },
    createClient: (token) => createGitHubClient(github.getOctokit(token), {
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
    },
    cwd: process.cwd(),
}).catch((error) => {
    core.setFailed(getErrorMessage(error));
});
