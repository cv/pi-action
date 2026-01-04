import { type GitHubClient } from "./github.js";
export interface ActionInputs {
    triggerPhrase: string;
    allowedBots: string[];
    timeout: number;
    provider: string;
    model: string;
    githubToken: string | undefined;
    piAuthJson: string | undefined;
    promptTemplate: string | undefined;
}
export interface ActionContext {
    payload: Record<string, unknown>;
    repo: {
        owner: string;
        repo: string;
    };
}
export interface ActionDependencies {
    inputs: ActionInputs;
    context: ActionContext;
    createClient: (token: string) => GitHubClient;
    log: {
        info: (msg: string) => void;
        warning: (msg: string) => void;
        error: (msg: string) => void;
        setFailed: (msg: string) => void;
    };
    cwd: string;
}
export declare function setupAuth(piAuthJson: string | undefined): void;
export declare function run(deps: ActionDependencies): Promise<void>;
