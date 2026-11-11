import * as core from "@actions/core";
import * as github from "@actions/github";
import { DEFAULTS, MIN_NODE_VERSION } from "./defaults.js";
import { createGitHubClient } from "./github.js";
import { run } from "./run.js";
import { getErrorMessage, nodeVersionAtLeast } from "./utils.js";
function getInputOrDefault(name, defaultValue) {
    const value = core.getInput(name);
    return value || defaultValue;
}
if (!nodeVersionAtLeast(process.versions.node, MIN_NODE_VERSION)) {
    core.setFailed(`pi-action needs Node.js ${MIN_NODE_VERSION} or newer (found ${process.versions.node}); use actions/setup-node with node-version: '24'`);
    process.exit(1);
}
for (const deprecated of ["gist_token", "share_session"]) {
    if (core.getInput(deprecated)) {
        core.warning(`${deprecated} is no longer used: the full session is kept in git on refs/pi/threads/<number>`);
    }
}
const repo = {
    owner: github.context.repo.owner,
    name: github.context.repo.repo,
};
run({
    inputs: {
        triggerPhrase: getInputOrDefault("trigger_phrase", DEFAULTS.triggerPhrase),
        allowedBots: (core.getInput("allowed_bots") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        modelConfig: {
            timeout: Number.parseInt(getInputOrDefault("timeout", String(DEFAULTS.timeout)), 10),
            provider: getInputOrDefault("provider", DEFAULTS.provider),
            model: getInputOrDefault("model", DEFAULTS.model),
        },
        githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
        piAuthJson: core.getInput("pi_auth_json"),
        modelsJson: core.getInput("models_json"),
        promptTemplate: core.getInput("prompt_template"),
        pollInterval: Number.parseInt(getInputOrDefault("poll_interval", String(DEFAULTS.pollInterval)), 10),
    },
    context: { payload: github.context.payload, repo },
    createClient: (token) => createGitHubClient(github.getOctokit(token), {
        repo,
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
