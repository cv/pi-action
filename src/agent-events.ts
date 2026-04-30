export interface AgentLogger {
	info: (msg: string) => void;
}

interface SessionEvent {
	type: string;
	toolName?: string;
	args?: Record<string, unknown> & {
		command?: unknown;
		path?: unknown;
	};
	isError?: boolean;
	assistantMessageEvent?: {
		type: string;
		delta?: string;
	};
}

export function createSessionEventHandler(
	log: AgentLogger,
	onTextDelta: (delta: string) => void,
): (event: SessionEvent) => void {
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch statement handling many event types
	return (event: SessionEvent) => {
		switch (event.type) {
			case "turn_start":
				log.info("🔄 Turn started");
				break;
			case "turn_end":
				log.info("✅ Turn completed");
				break;
			case "tool_execution_start": {
				log.info(`🔧 Tool: ${event.toolName}`);
				const command = event.args?.command;
				const path = event.args?.path;
				if (event.toolName === "bash" && command) {
					log.info(`   $ ${command}`);
				} else if (event.toolName === "read" && path) {
					log.info(`   📖 ${path}`);
				} else if (event.toolName === "write" && path) {
					log.info(`   ✏️ ${path}`);
				} else if (event.toolName === "edit" && path) {
					log.info(`   📝 ${path}`);
				}
				break;
			}
			case "tool_execution_end":
				if (event.isError) {
					log.info(`   ❌ Tool error: ${event.toolName}`);
				}
				break;
			case "message_update":
				if (event.assistantMessageEvent?.type === "text_delta") {
					onTextDelta(event.assistantMessageEvent.delta ?? "");
				}
				break;
			default:
				break;
		}
	};
}
