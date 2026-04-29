import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { PIContext } from "./context.js";
import type { AgentResult, ModelConfig } from "./types.js";
export interface AgentLogger {
    info: (msg: string) => void;
}
export interface AgentConfig extends ModelConfig {
    cwd: string;
    logger?: AgentLogger;
    apiKey?: string;
    promptTemplate?: string;
}
export declare function runAgent(piContext: PIContext, config: AgentConfig, authStorage?: AuthStorage, modelRegistry?: ModelRegistry): Promise<AgentResult>;
