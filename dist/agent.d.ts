import { type AuthStorage, type ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { PIContext } from "./context.js";
import type { AgentResult } from "./types.js";
export interface AgentConfig {
    provider: string;
    model: string;
    timeout: number;
    cwd: string;
    promptTemplate?: string;
}
export declare function runAgent(piContext: PIContext, config: AgentConfig, authStorage?: AuthStorage, modelRegistry?: ModelRegistry): Promise<AgentResult>;
