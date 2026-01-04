import * as core from "@actions/core";
import * as github from "@actions/github";
import { createGitHubClient } from "./github.js";
import { run } from "./run.js";
import { getErrorMessage } from "./utils.js";
run({
    inputs: {
        triggerPhrase: core.getInput("trigger_phrase") || "@pi",
        allowedBots: (core.getInput("allowed_bots") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        timeout: Number.parseInt(core.getInput("timeout") || "300", 10),
        provider: core.getInput("provider") || "anthropic",
        model: core.getInput("model") || "claude-sonnet-4-20250514",
        githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
        piAuthJson: core.getInput("pi_auth_json"),
        promptTemplate: core.getInput("prompt_template"),
    },
    context: {
        payload: github.context.payload,
        repo: github.context.repo,
    },
    createClient: (token) => createGitHubClient(github.getOctokit(token), github.context),
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
