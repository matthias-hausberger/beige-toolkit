import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PluginContext,
  PluginRegistrar,
  PluginTool,
  ChannelAdapter,
  PluginSkill,
  HookName,
  HookHandler,
} from "@matthias-hausberger/beige";

// We can't import grammy in tests without a real token, so we mock the module
const handlers: Record<string, Function> = {};
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  editMessageText: vi.fn().mockResolvedValue(undefined),
  deleteMyCommands: vi.fn().mockResolvedValue(undefined),
  setMyCommands: vi.fn().mockResolvedValue(undefined),
};
const mockBotInstance = {
  use: vi.fn(),
  command: vi.fn((cmd: string, handler: Function) => {
    handlers[`command:${cmd}`] = handler;
  }),
  on: vi.fn((event: string, handler: Function) => {
    handlers[`on:${event}`] = handler;
  }),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  api: mockBotApi,
  _handlers: handlers,
};

vi.mock("grammy", () => {
  // Must use a function() (not arrow) so it can be called with `new`
  function MockBot() {
    return mockBotInstance;
  }
  return {
    Bot: MockBot,
  };
});

// Import after mocking
import { createPlugin } from "../../plugins/telegram/index.ts";

function createMockPluginContext(): PluginContext {
  const metadata: Record<string, Record<string, unknown>> = {};

  return {
    prompt: vi.fn().mockResolvedValue("Test response"),
    promptStreaming: vi.fn().mockResolvedValue("Streamed response"),
    newSession: vi.fn().mockResolvedValue(undefined),
    getSessionSettings: vi.fn().mockReturnValue({}),
    updateSessionSettings: vi.fn(),
    setSessionMetadata: vi.fn((sessionKey: string, key: string, value: unknown) => {
      if (!metadata[sessionKey]) metadata[sessionKey] = {};
      metadata[sessionKey][key] = value;
    }),
    getSessionMetadata: vi.fn((sessionKey: string, key: string) => {
      return metadata[sessionKey]?.[key];
    }),
    invokeTool: vi.fn().mockResolvedValue({ output: "", exitCode: 0 }),
    config: {},
    agentNames: ["assistant"],
    getChannel: vi.fn(),
    getRegisteredTools: vi.fn().mockReturnValue([]),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function createMockRegistrar(): PluginRegistrar & {
  tools: PluginTool[];
  channels: ChannelAdapter[];
  skills: PluginSkill[];
  hooks: Array<{ name: HookName; handler: HookHandler }>;
} {
  const tools: PluginTool[] = [];
  const channels: ChannelAdapter[] = [];
  const skills: PluginSkill[] = [];
  const hooks: Array<{ name: HookName; handler: HookHandler }> = [];

  return {
    tools,
    channels,
    skills,
    hooks,
    tool: (t) => tools.push(t),
    channel: (c) => channels.push(c),
    hook: ((name: HookName, handler: HookHandler) => hooks.push({ name, handler })) as any,
    skill: (s) => skills.push(s),
  };
}

const validConfig = {
  token: "fake-token",
  allowedUsers: [123456],
  agentMapping: { default: "assistant" },
  defaults: { verbose: false, streaming: true },
};

describe("Telegram Plugin", () => {
  let ctx: PluginContext;
  let reg: ReturnType<typeof createMockRegistrar>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockPluginContext();
    reg = createMockRegistrar();
  });

  describe("createPlugin", () => {
    it("creates a plugin instance with valid config", () => {
      const plugin = createPlugin(validConfig, ctx);
      expect(plugin).toBeDefined();
      expect(plugin.register).toBeTypeOf("function");
      expect(plugin.start).toBeTypeOf("function");
      expect(plugin.stop).toBeTypeOf("function");
    });

    it("throws on missing token", () => {
      expect(() =>
        createPlugin({ ...validConfig, token: "" }, ctx)
      ).toThrow("token");
    });

    it("throws on missing allowedUsers", () => {
      expect(() =>
        createPlugin({ ...validConfig, allowedUsers: [] }, ctx)
      ).toThrow("allowedUsers");
    });

    it("throws on missing agentMapping.default", () => {
      expect(() =>
        createPlugin({ ...validConfig, agentMapping: {} }, ctx)
      ).toThrow("agentMapping.default");
    });
  });

  describe("register()", () => {
    it("registers a channel adapter", () => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);

      expect(reg.channels).toHaveLength(1);
      expect(reg.channels[0].supportsMessaging()).toBe(true);
    });

    it("registers the telegram tool", () => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);

      expect(reg.tools).toHaveLength(1);
      expect(reg.tools[0].name).toBe("telegram");
      expect(reg.tools[0].description).toContain("Send messages");
    });

    it("does not register hooks or skills", () => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);

      expect(reg.hooks).toHaveLength(0);
      expect(reg.skills).toHaveLength(0);
    });
  });

  describe("telegram tool", () => {
    let tool: PluginTool;

    beforeEach(() => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);
      tool = reg.tools[0];
    });

    it("shows usage on empty args", async () => {
      const result = await tool.handler([], undefined);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Usage");
    });

    it("shows usage on unknown subcommand", async () => {
      const result = await tool.handler(["unknown"], undefined);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Unknown subcommand");
    });

    it("sendMessage with insufficient args", async () => {
      const result = await tool.handler(["sendMessage", "123"], undefined);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Usage");
    });

    it("sendMessage sends a message", async () => {
      const result = await tool.handler(
        ["sendMessage", "123456", "Hello", "world"],
        undefined
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Message sent");
      expect(result.output).toContain("123456");
    });

    it("sendMessage with --thread option", async () => {
      const result = await tool.handler(
        ["sendMessage", "123456", "--thread", "42", "Thread", "message"],
        undefined
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("thread 42");
    });

    it("sendMessage with empty text after --thread", async () => {
      const result = await tool.handler(
        ["sendMessage", "123456", "--thread", "42", ""],
        undefined
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("empty");
    });

    it("accepts send as alias for sendMessage", async () => {
      const result = await tool.handler(
        ["send", "123456", "Hello"],
        undefined
      );
      expect(result.exitCode).toBe(0);
    });

    it("accepts send_message as alias for sendMessage", async () => {
      const result = await tool.handler(
        ["send_message", "123456", "Hello"],
        undefined
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("channel adapter", () => {
    let adapter: ChannelAdapter;

    beforeEach(() => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);
      adapter = reg.channels[0];
    });

    it("supports messaging", () => {
      expect(adapter.supportsMessaging()).toBe(true);
    });

    it("sends a message", async () => {
      await adapter.sendMessage("123", undefined, "Hello");
      // The mock bot.api.sendMessage is called internally
      
      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(
        "123",
        "Hello",
        expect.objectContaining({})
      );
    });

    it("sends a message with thread", async () => {
      await adapter.sendMessage("123", "42", "Hello");
      
      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(
        "123",
        "Hello",
        expect.objectContaining({ message_thread_id: 42 })
      );
    });
  });

  describe("lifecycle", () => {
    it("start() starts the bot", async () => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);
      await plugin.start!();

      
      expect(mockBotApi.deleteMyCommands).toHaveBeenCalled();
      expect(mockBotApi.setMyCommands).toHaveBeenCalled();
      expect(mockBotInstance.start).toHaveBeenCalled();
    });

    it("stop() stops the bot", async () => {
      const plugin = createPlugin(validConfig, ctx);
      plugin.register(reg);
      await plugin.stop!();

      
      expect(mockBotInstance.stop).toHaveBeenCalled();
    });
  });
});
