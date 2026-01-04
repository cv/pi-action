import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentConfig, runAgent } from "./agent.js";
import type { PIContext } from "./context.js";

// Mock the pi-coding-agent SDK
vi.mock("@mariozechner/pi-coding-agent", () => {
	const mockSession = {
		subscribe: vi.fn(),
		prompt: vi.fn(),
	};

	return {
		createAgentSession: vi.fn(() => Promise.resolve({ session: mockSession })),
		SessionManager: {
			inMemory: vi.fn(() => ({})),
		},
		SettingsManager: {
			inMemory: vi.fn(() => ({})),
		},
		createCodingTools: vi.fn(() => []),
		discoverAuthStorage: vi.fn(() => ({
			get: vi.fn(),
			setRuntimeApiKey: vi.fn(),
		})),
		discoverModels: vi.fn(() => ({
			find: vi.fn(),
			getAll: vi.fn(() => []),
			getAvailable: vi.fn(() => []),
		})),
	};
});

// Get references to mocked functions
import {
	createAgentSession,
	discoverModels,
} from "@mariozechner/pi-coding-agent";

const mockCreateAgentSession = createAgentSession as Mock;
const mockDiscoverModels = discoverModels as Mock;

describe("runAgent", () => {
	const defaultContext: PIContext = {
		type: "issue",
		title: "Test Issue",
		body: "Issue body",
		number: 1,
		triggerComment: "@pi do something",
		task: "do something",
	};

	const defaultConfig: AgentConfig = {
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		timeout: 300,
		cwd: "/test/dir",
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns error when model not found", async () => {
		const mockRegistry = {
			find: vi.fn(() => undefined),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const result = await runAgent(defaultContext, defaultConfig);

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			"Model not found: anthropic/claude-sonnet-4-20250514",
		);
	});

	it("successfully runs agent and returns response", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		let subscribeCallback: ((event: unknown) => void) | null = null;
		const mockSession = {
			subscribe: vi.fn((cb) => {
				subscribeCallback = cb;
			}),
			prompt: vi.fn(async () => {
				// Simulate streaming response
				if (subscribeCallback) {
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "Hello " },
					});
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "world!" },
					});
				}
			}),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const result = await runAgent(defaultContext, defaultConfig);

		expect(result.success).toBe(true);
		expect(result.response).toBe("Hello world!");
		expect(mockSession.prompt).toHaveBeenCalled();
	});

	it("ignores non-text-delta events", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		let subscribeCallback: ((event: unknown) => void) | null = null;
		const mockSession = {
			subscribe: vi.fn((cb) => {
				subscribeCallback = cb;
			}),
			prompt: vi.fn(async () => {
				if (subscribeCallback) {
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: {
							type: "thinking_delta",
							delta: "thinking...",
						},
					});
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "Response" },
					});
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "read",
					});
				}
			}),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const result = await runAgent(defaultContext, defaultConfig);

		expect(result.success).toBe(true);
		expect(result.response).toBe("Response");
	});

	it("returns error when session creation fails", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		mockCreateAgentSession.mockRejectedValue(new Error("Auth failed"));

		const result = await runAgent(defaultContext, defaultConfig);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Auth failed");
	});

	it("returns error when prompt fails", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const mockSession = {
			subscribe: vi.fn(),
			prompt: vi.fn().mockRejectedValue(new Error("API error")),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const result = await runAgent(defaultContext, defaultConfig);

		expect(result.success).toBe(false);
		expect(result.error).toBe("API error");
	});

	it("handles timeout", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const mockSession = {
			subscribe: vi.fn(),
			prompt: vi.fn(() => new Promise(() => {})), // Never resolves
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const result = await runAgent(defaultContext, {
			...defaultConfig,
			timeout: 0.1, // 100ms timeout
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Timeout");
	}, 1000);

	it("handles unknown errors", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		mockCreateAgentSession.mockRejectedValue("string error");

		const result = await runAgent(defaultContext, defaultConfig);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Unknown error");
	});

	it("uses provided authStorage and modelRegistry", async () => {
		const customAuth = { get: vi.fn() };
		const customModel = { provider: "openai", id: "gpt-4" };
		const customRegistry = {
			find: vi.fn(() => customModel),
		};

		const mockSession = {
			subscribe: vi.fn(),
			prompt: vi.fn(),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(
			defaultContext,
			{ ...defaultConfig, provider: "openai", model: "gpt-4" },
			// @ts-expect-error - mocking in tests
			customAuth,
			// @ts-expect-error - mocking in tests
			customRegistry,
		);

		expect(customRegistry.find).toHaveBeenCalledWith("openai", "gpt-4");
		expect(mockDiscoverModels).not.toHaveBeenCalled();
	});

	it("passes correct options to createAgentSession", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const mockSession = {
			subscribe: vi.fn(),
			prompt: vi.fn(),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(defaultContext, defaultConfig);

		expect(mockCreateAgentSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/test/dir",
				model: mockModel,
				thinkingLevel: "off",
				hooks: [],
				skills: [],
				contextFiles: [],
				slashCommands: [],
			}),
		);
	});

	it("includes diff in prompt for pull requests", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		let capturedPrompt = "";
		const mockSession = {
			subscribe: vi.fn(),
			prompt: vi.fn((prompt: string) => {
				capturedPrompt = prompt;
			}),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const prContext: PIContext = {
			type: "pull_request",
			title: "Add feature",
			body: "PR body",
			number: 42,
			triggerComment: "@pi review",
			task: "review",
			diff: "+added line\n-removed line",
		};

		await runAgent(prContext, defaultConfig);

		expect(capturedPrompt).toContain("Pull Request");
		expect(capturedPrompt).toContain("PR Diff");
		expect(capturedPrompt).toContain("+added line");
	});

	it("logs tool executions when logger is provided", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const logMessages: string[] = [];
		const mockLogger = {
			info: vi.fn((msg: string) => logMessages.push(msg)),
		};

		let subscribeCallback: ((event: unknown) => void) | null = null;
		const mockSession = {
			subscribe: vi.fn((cb) => {
				subscribeCallback = cb;
			}),
			prompt: vi.fn(async () => {
				if (subscribeCallback) {
					subscribeCallback({ type: "turn_start" });
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "bash",
						args: { command: "ls -la" },
					});
					subscribeCallback({
						type: "tool_execution_end",
						toolName: "bash",
						isError: false,
					});
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "read",
						args: { path: "/test/file.ts" },
					});
					subscribeCallback({
						type: "tool_execution_end",
						toolName: "read",
						isError: false,
					});
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "write",
						args: { path: "/test/new.ts" },
					});
					subscribeCallback({
						type: "tool_execution_end",
						toolName: "write",
						isError: false,
					});
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "edit",
						args: { path: "/test/edit.ts" },
					});
					subscribeCallback({
						type: "tool_execution_end",
						toolName: "edit",
						isError: false,
					});
					subscribeCallback({ type: "turn_end" });
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "Done" },
					});
				}
			}),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(defaultContext, { ...defaultConfig, logger: mockLogger });

		expect(logMessages).toContain("🔄 Turn started");
		expect(logMessages).toContain("🔧 Tool: bash");
		expect(logMessages).toContain("   $ ls -la");
		expect(logMessages).toContain("🔧 Tool: read");
		expect(logMessages).toContain("   📖 /test/file.ts");
		expect(logMessages).toContain("🔧 Tool: write");
		expect(logMessages).toContain("   ✏️ /test/new.ts");
		expect(logMessages).toContain("🔧 Tool: edit");
		expect(logMessages).toContain("   📝 /test/edit.ts");
		expect(logMessages).toContain("✅ Turn completed");
	});

	it("logs tool errors", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const logMessages: string[] = [];
		const mockLogger = {
			info: vi.fn((msg: string) => logMessages.push(msg)),
		};

		let subscribeCallback: ((event: unknown) => void) | null = null;
		const mockSession = {
			subscribe: vi.fn((cb) => {
				subscribeCallback = cb;
			}),
			prompt: vi.fn(async () => {
				if (subscribeCallback) {
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "bash",
						args: { command: "exit 1" },
					});
					subscribeCallback({
						type: "tool_execution_end",
						toolName: "bash",
						isError: true,
					});
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "Failed" },
					});
				}
			}),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(defaultContext, { ...defaultConfig, logger: mockLogger });

		expect(logMessages).toContain("   ❌ Tool error: bash");
	});

	it("handles tools without args gracefully", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockDiscoverModels.mockReturnValue(mockRegistry);

		const logMessages: string[] = [];
		const mockLogger = {
			info: vi.fn((msg: string) => logMessages.push(msg)),
		};

		let subscribeCallback: ((event: unknown) => void) | null = null;
		const mockSession = {
			subscribe: vi.fn((cb) => {
				subscribeCallback = cb;
			}),
			prompt: vi.fn(async () => {
				if (subscribeCallback) {
					subscribeCallback({
						type: "tool_execution_start",
						toolName: "custom_tool",
						args: {},
					});
					subscribeCallback({
						type: "tool_execution_end",
						toolName: "custom_tool",
						isError: false,
					});
					subscribeCallback({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "Done" },
					});
				}
			}),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(defaultContext, { ...defaultConfig, logger: mockLogger });

		expect(logMessages).toContain("🔧 Tool: custom_tool");
		// Should not have additional log lines for args since they're empty
		expect(logMessages.filter((m) => m.startsWith("   "))).toHaveLength(0);
	});

	it("passes custom prompt template through to buildPrompt", async () => {
		const mockModel = { id: "test-model", name: "Test Model" };
		const mockSession = {
			subscribe: vi.fn((cb) => {
				cb({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "Response" },
				});
			}),
			prompt: vi.fn(async () => {}),
		};

		mockDiscoverModels.mockReturnValue({
			find: vi.fn().mockReturnValue(mockModel),
		});
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const customTemplate = "Custom: {{task}} for {{number}}";
		await runAgent(defaultContext, {
			...defaultConfig,
			promptTemplate: customTemplate,
		});

		// Verify that the session.prompt was called with the custom template result
		// Since we can't easily mock buildPrompt, we'll verify that it was called
		expect(mockSession.prompt).toHaveBeenCalled();
		const promptArg = mockSession.prompt.mock.calls[0][0];
		expect(promptArg).toBe("Custom: do something for 1");
	});
});
