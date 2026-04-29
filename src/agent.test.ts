import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { runAgent } from "./agent.js";
import {
	createAgentConfig,
	createMockSession,
	createPIContext,
} from "./test-helpers.js";
import type { AgentResult } from "./types.js";

// Mock the pi-coding-agent SDK
vi.mock("@mariozechner/pi-coding-agent", () => {
	const mockSession = {
		subscribe: vi.fn(),
		prompt: vi.fn(),
	};

	class MockDefaultResourceLoader {
		reload = vi.fn(async () => undefined);
	}

	return {
		AuthStorage: {
			inMemory: vi.fn(() => ({
				get: vi.fn(),
				setRuntimeApiKey: vi.fn(),
			})),
		},
		DefaultResourceLoader: MockDefaultResourceLoader,
		ModelRegistry: {
			inMemory: vi.fn(() => ({
				find: vi.fn(),
				getAll: vi.fn(() => []),
				getAvailable: vi.fn(() => []),
				registerProvider: vi.fn(),
			})),
		},
		createAgentSession: vi.fn(() => Promise.resolve({ session: mockSession })),
		getAgentDir: vi.fn(() => "/mock/agent"),
		SessionManager: {
			inMemory: vi.fn(() => ({})),
			create: vi.fn(() => ({})),
		},
		SettingsManager: {
			inMemory: vi.fn(() => ({})),
		},
	};
});

// Get references to mocked functions
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
} from "@mariozechner/pi-coding-agent";

const mockAuthStorageInMemory = AuthStorage.inMemory as Mock;
const mockCreateAgentSession = createAgentSession as Mock;
const mockModelRegistryInMemory = ModelRegistry.inMemory as Mock;

function assertSuccess(
	result: AgentResult,
): asserts result is Extract<AgentResult, { success: true }> {
	if (!result.success) {
		throw new Error(result.error);
	}
}

function assertFailure(
	result: AgentResult,
): asserts result is Extract<AgentResult, { success: false }> {
	if (result.success) {
		throw new Error(result.response);
	}
}

describe("runAgent", () => {
	const defaultContext = createPIContext();
	const defaultConfig = createAgentConfig();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns error when model not found", async () => {
		const mockRegistry = {
			find: vi.fn(() => undefined),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		const result = await runAgent(defaultContext, defaultConfig);

		assertFailure(result);
		expect(result.error).toBe(
			"Model not found: anthropic/claude-sonnet-4-20250514",
		);
	});

	it("successfully runs agent and returns response", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

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

		assertSuccess(result);
		expect(result.response).toBe("Hello world!");
		expect(mockSession.prompt).toHaveBeenCalled();
	});

	it("ignores non-text-delta events", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

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

		assertSuccess(result);
		expect(result.response).toBe("Response");
	});

	it("returns error when session creation fails", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		mockCreateAgentSession.mockRejectedValue(new Error("Auth failed"));

		const result = await runAgent(defaultContext, defaultConfig);

		assertFailure(result);
		expect(result.error).toBe("Auth failed");
	});

	it("returns error when prompt fails", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		const mockSession = {
			subscribe: vi.fn(),
			prompt: vi.fn().mockRejectedValue(new Error("API error")),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const result = await runAgent(defaultContext, defaultConfig);

		assertFailure(result);
		expect(result.error).toBe("API error");
	});

	it("handles timeout", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		const mockSession = {
			subscribe: vi.fn(),
			// biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally never resolves for timeout test
			prompt: vi.fn(() => new Promise(() => {})),
		};
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const result = await runAgent(defaultContext, {
			...defaultConfig,
			timeout: 0.1, // 100ms timeout
		});

		assertFailure(result);
		expect(result.error).toContain("Timeout");
	}, 1000);

	it("handles string errors", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		mockCreateAgentSession.mockRejectedValue("string error");

		const result = await runAgent(defaultContext, defaultConfig);

		assertFailure(result);
		expect(result.error).toBe("string error");
	});

	it("handles truly unknown errors", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		mockCreateAgentSession.mockRejectedValue(42);

		const result = await runAgent(defaultContext, defaultConfig);

		assertFailure(result);
		expect(result.error).toBe("Unknown error");
	});

	it("uses provided authStorage and modelRegistry", async () => {
		const customAuth = { get: vi.fn() };
		const customModel = { provider: "openai", id: "gpt-4" };
		const customRegistry = {
			find: vi.fn(() => customModel),
		};

		const mockSession = createMockSession();
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(
			defaultContext,
			createAgentConfig({ provider: "openai", model: "gpt-4" }),
			customAuth as unknown as Parameters<typeof runAgent>[2],
			customRegistry as unknown as Parameters<typeof runAgent>[3],
		);

		expect(customRegistry.find).toHaveBeenCalledWith("openai", "gpt-4");
		expect(mockModelRegistryInMemory).not.toHaveBeenCalled();
	});

	it("sets api_key as a runtime provider credential", async () => {
		const mockAuth = {
			get: vi.fn(),
			setRuntimeApiKey: vi.fn(),
		};
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockAuthStorageInMemory.mockReturnValue(mockAuth);
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);
		mockCreateAgentSession.mockResolvedValue({ session: createMockSession() });

		await runAgent(defaultContext, {
			...defaultConfig,
			apiKey: "sk-test",
		});

		expect(mockAuth.setRuntimeApiKey).toHaveBeenCalledWith(
			"anthropic",
			"sk-test",
		);
	});

	it("registers a single custom provider/model", async () => {
		const mockModel = { provider: "nvidia", id: "openai/openai/gpt-5.5" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
			registerProvider: vi.fn(),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);
		mockCreateAgentSession.mockResolvedValue({ session: createMockSession() });

		await runAgent(defaultContext, {
			...defaultConfig,
			provider: "nvidia",
			model: "openai/openai/gpt-5.5",
			apiKey: "sk-test",
			customProvider: {
				baseUrl: "https://inference-api.nvidia.com",
				api: "openai-responses",
				authHeader: false,
				modelName: "GPT-5.5 (OpenAI)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1050000,
				maxTokens: 16384,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
		});

		expect(mockRegistry.registerProvider).toHaveBeenCalledWith("nvidia", {
			baseUrl: "https://inference-api.nvidia.com",
			api: "openai-responses",
			apiKey: "nvidia",
			authHeader: false,
			models: [
				{
					id: "openai/openai/gpt-5.5",
					name: "GPT-5.5 (OpenAI)",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1050000,
					maxTokens: 16384,
					compat: {
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				},
			],
		});
	});

	it("returns an error when custom provider auth is missing", async () => {
		const mockRegistry = {
			find: vi.fn(),
			registerProvider: vi.fn(),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		const result = await runAgent(defaultContext, {
			...defaultConfig,
			customProvider: {
				baseUrl: "https://inference-api.nvidia.com",
				api: "openai-responses",
				authHeader: false,
				reasoning: true,
				input: ["text"],
				contextWindow: 1050000,
				maxTokens: 16384,
			},
		});

		assertFailure(result);
		expect(result.error).toBe(
			"api_key or provider_api_key is required when provider_base_url is set",
		);
		expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
	});

	it("passes correct options to createAgentSession", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		const mockSession = createMockSession();
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		await runAgent(defaultContext, defaultConfig);

		expect(mockCreateAgentSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/test/dir",
				model: mockModel,
				thinkingLevel: "off",
				tools: ["read", "bash", "edit", "write"],
				resourceLoader: expect.any(DefaultResourceLoader),
			}),
		);
	});

	it("includes diff in prompt for pull requests", async () => {
		const mockModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		const mockRegistry = {
			find: vi.fn(() => mockModel),
		};
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

		let capturedPrompt = "";
		const mockSession = createMockSession();
		mockSession.prompt.mockImplementation((prompt: string) => {
			capturedPrompt = prompt;
		});
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const prContext = createPIContext({
			type: "pull_request",
			title: "Add feature",
			body: "PR body",
			number: 42,
			triggerComment: "@pi review",
			task: "review",
			diff: "+added line\n-removed line",
		});

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
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

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
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

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
		mockModelRegistryInMemory.mockReturnValue(mockRegistry);

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
			// biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation
			prompt: vi.fn(async () => {}),
		};

		mockModelRegistryInMemory.mockReturnValue({
			find: vi.fn().mockReturnValue(mockModel),
		});
		mockCreateAgentSession.mockResolvedValue({ session: mockSession });

		const customTemplate = "Custom: {{task}} for {{number}}";
		await runAgent(defaultContext, {
			...defaultConfig,
			promptTemplate: customTemplate,
		});

		expect(mockSession.prompt).toHaveBeenCalledWith(
			"Custom: do something for 1",
		);
	});
});
