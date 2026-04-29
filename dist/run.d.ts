import { type GitHubClient } from "./github.js";
import type { ModelConfig, RepoRef } from "./types.js";
export interface ActionInputs {
    triggerPhrase: string;
    allowedBots: string[];
    modelConfig: ModelConfig;
    githubToken: string | undefined;
    gistToken: string | undefined;
    apiKey: string | undefined;
    promptTemplate: string | undefined;
    shareSession: boolean;
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
}
export declare function run(deps: ActionDependencies): Promise<void>;
