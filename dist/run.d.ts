import type { Models } from "@earendil-works/pi-ai/models";
import { type GitHubClient } from "./github.js";
import type { ModelConfig, RepoRef } from "./types.js";
export interface ActionInputs {
    triggerPhrase: string;
    allowedBots: string[];
    modelConfig: ModelConfig;
    githubToken: string | undefined;
    piAuthJson: string | undefined;
    modelsJson?: string | undefined;
    promptTemplate: string | undefined;
    /** Seconds between checks for new comments while pi works. */
    pollInterval?: number;
}
export interface ActionContext {
    payload: Record<string, unknown>;
    repo: RepoRef;
}
export interface Logger {
    info: (msg: string) => void;
    warning: (msg: string) => void;
    error: (msg: string) => void;
    setFailed: (msg: string) => void;
}
export interface ActionDependencies {
    inputs: ActionInputs;
    context: ActionContext;
    createClient: (token: string) => GitHubClient;
    log: Logger;
    cwd: string;
    /** Override model setup (tests use a faux provider). */
    createModels?: (inputs: ActionInputs, log: Logger) => Promise<Models>;
    /** Git remote holding the thread refs. Default "origin". */
    remote?: string;
}
export declare function run(deps: ActionDependencies): Promise<void>;
