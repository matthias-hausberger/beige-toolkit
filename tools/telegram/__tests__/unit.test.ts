/**
 * Unit tests for the Telegram tool handler.
 *
 * Tests use mocked curl execution — no real HTTP requests are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createHandler,
  parseArgs,
  isChatAllowed,
  apiUrl,
} from "../index.js";

// ---------------------------------------------------------------------------
// Mock curl executor
// ---------------------------------------------------------------------------

interface MockCall {
  args: string[];
  timestamp: number;
}

let mockCalls: MockCall[] = [];
let mockResponse: { stdout: string; stderr: string; exitCode: number } = {
  stdout: "",
  stderr: "",
  exitCode: 0,
};

// Mock spawn to capture curl calls
vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    const call = {
      args: vi.mocked.lastCall()?.[1] as string[],
      timestamp: Date.now(),
    };
    mockCalls.push(call);

    return {
      stdout: {
        on: (_event: string, cb: (data: Buffer) => void) => {
          if (mockResponse.stdout) {
            cb(Buffer.from(mockResponse.stdout));
          }
        },
      },
      stderr: {
        on: (_event: string, cb: (data: Buffer) => void) => {
          if (mockResponse.stderr) {
            cb(Buffer.from(mockResponse.stderr));
          }
        },
      },
      on: (_event: string, cb: (code: number) => void) => {
        setTimeout(() => cb(mockResponse.exitCode), 0);
      },
      kill: vi.fn(),
    };
  }),
}));

function resetMock() {
  mockCalls = [];
  mockResponse = { stdout: "", stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// parseArgs tests
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses empty args", () => {
    const result = parseArgs([]);
    expect(result.subcommand).toBe("");
    expect(result.args).toEqual({});
  });

  it("extracts subcommand", () => {
    const result = parseArgs(["send"]);
    expect(result.subcommand).toBe("send");
  });

  it("parses --key value", () => {
    const result = parseArgs(["send", "--chat", "12345", "--text", "hello"]);
    expect(result.args.chat).toBe(12345);
    expect(result.args.text).toBe("hello");
  });

  it("parses --key=value", () => {
    const result = parseArgs(["send", "--chat=12345", "--text=hello"]);
    expect(result.args.chat).toBe(12345);
    expect(result.args.text).toBe("hello");
  });

  it("parses boolean flags", () => {
    const result = parseArgs(["send", "--silent"]);
    expect(result.args.silent).toBe(true);
  });

  it("parses numeric values", () => {
    const result = parseArgs(["send", "--chat", "58687206", "--reply-to", "123"]);
    expect(result.args.chat).toBe(58687206);
    expect(result.args["reply-to"]).toBe(123);
  });

  it("preserves string values for non-numeric", () => {
    const result = parseArgs(["send", "--text", "Hello world!", "--parse-mode", "Markdown"]);
    expect(result.args.text).toBe("Hello world!");
    expect(result.args["parse-mode"]).toBe("Markdown");
  });
});

// ---------------------------------------------------------------------------
// isChatAllowed tests
// ---------------------------------------------------------------------------

describe("isChatAllowed", () => {
  it("allows any chat when no restrictions configured", () => {
    expect(isChatAllowed("58687206", {}).allowed).toBe(true);
    expect(isChatAllowed(-1001234567890, {}).allowed).toBe(true);
  });

  it("blocks chats in deny list", () => {
    const config = { denyChats: ["58687206", -1009999999999] };
    expect(isChatAllowed("58687206", config).allowed).toBe(false);
    expect(isChatAllowed(58687206, config).allowed).toBe(false);
    expect(isChatAllowed(-1009999999999, config).allowed).toBe(false);
    expect(isChatAllowed("12345678", config).allowed).toBe(true);
  });

  it("allows only chats in allow list", () => {
    const config = { allowChats: ["58687206", -1001234567890] };
    expect(isChatAllowed("58687206", config).allowed).toBe(true);
    expect(isChatAllowed(58687206, config).allowed).toBe(true);
    expect(isChatAllowed("12345678", config).allowed).toBe(false);
  });

  it("deny beats allow", () => {
    const config = {
      allowChats: ["58687206"],
      denyChats: ["58687206"],
    };
    expect(isChatAllowed("58687206", config).allowed).toBe(false);
  });

  it("normalizes chat IDs as strings", () => {
    const config = { denyChats: [58687206] };
    // String form should also be blocked
    expect(isChatAllowed("58687206", config).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apiUrl tests
// ---------------------------------------------------------------------------

describe("apiUrl", () => {
  it("builds correct API URL", () => {
    const token = "1234567890:ABCdef";
    expect(apiUrl(token, "sendMessage")).toBe(
      "https://api.telegram.org/bot1234567890:ABCdef/sendMessage"
    );
    expect(apiUrl(token, "getMe")).toBe(
      "https://api.telegram.org/bot1234567890:ABCdef/getMe"
    );
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe("handler", () => {
  beforeEach(() => {
    resetMock();
  });

  const defaultConfig = {
    botToken: "test-token-12345",
    defaultChatId: "58687206",
  };

  it("returns usage when called with no args", async () => {
    const handler = createHandler(defaultConfig);
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
    expect(result.output).toContain("telegram");
  });

  it("returns usage for help subcommand", async () => {
    const handler = createHandler(defaultConfig);
    const result = await handler(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("telegram");
  });

  it("rejects unknown subcommand", async () => {
    const handler = createHandler(defaultConfig);
    const result = await handler(["unknown"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown subcommand");
  });
});

// ---------------------------------------------------------------------------
// send message tests
// ---------------------------------------------------------------------------

describe("handler - send", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
    defaultChatId: "58687206",
  };

  it("sends basic message", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["send", "--chat", "58687206", "--text", "Hello!"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Message sent successfully");

    // Check curl was called correctly
    expect(mockCalls.length).toBe(1);
    const curlArgs = mockCalls[0].args;
    expect(curlArgs).toContain("-X");
    expect(curlArgs).toContain("POST");
    expect(curlArgs).toContain("Content-Type: application/json");
  });

  it("uses defaultChatId when --chat not specified", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["send", "--text", "Hello!"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("58687206");
  });

  it("errors when no chat ID available", async () => {
    const handler = createHandler({ botToken: "test-token" });
    const result = await handler(["send", "--text", "Hello!"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No chat ID specified");
    expect(mockCalls.length).toBe(0);
  });

  it("errors when no text provided", async () => {
    const handler = createHandler(config);
    const result = await handler(["send", "--chat", "58687206"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No message text specified");
    expect(mockCalls.length).toBe(0);
  });

  it("errors when botToken not configured", async () => {
    const handler = createHandler({});
    const result = await handler(["send", "--chat", "58687206", "--text", "Hi"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("botToken not configured");
    expect(mockCalls.length).toBe(0);
  });

  it("blocks message to denied chat", async () => {
    const handler = createHandler({
      ...config,
      denyChats: ["58687206"],
    });
    const result = await handler(["send", "--chat", "58687206", "--text", "Hi"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("deny list");
    expect(mockCalls.length).toBe(0);
  });

  it("blocks message to non-allowed chat", async () => {
    const handler = createHandler({
      ...config,
      allowChats: ["12345678"],
    });
    const result = await handler(["send", "--chat", "58687206", "--text", "Hi"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("not in allow list");
    expect(mockCalls.length).toBe(0);
  });

  it("handles Telegram API error", async () => {
    mockResponse = {
      stdout: JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["send", "--chat", "58687206", "--text", "Hi"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Telegram API error");
    expect(result.output).toContain("chat not found");
  });

  it("includes thread ID in request", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    await handler(["send", "--chat", "-1001234567890", "--text", "Topic!", "--thread", "42"]);

    expect(mockCalls.length).toBe(1);
    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.message_thread_id).toBe(42);
  });

  it("includes reply_to_message_id in request", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 2 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    await handler(["send", "--chat", "58687206", "--text", "Reply!", "--reply-to", "123"]);

    expect(mockCalls.length).toBe(1);
    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.reply_to_message_id).toBe(123);
  });

  it("includes parse_mode in request", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    await handler(["send", "--chat", "58687206", "--text", "*bold*", "--parse-mode", "Markdown"]);

    expect(mockCalls.length).toBe(1);
    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.parse_mode).toBe("Markdown");
  });

  it("includes thread id when --thread", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    await handler(["send", "--chat", "58687206", "--text", "Topic!", "--thread", "42"]);

    expect(mockCalls.length).toBe(1);
    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.message_thread_id).toBe(42);
  });

  it("includes disable_notification when --silent", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    await handler(["send", "--chat", "58687206", "--text", "Quiet!", "--silent"]);

    expect(mockCalls.length).toBe(1);
    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.disable_notification).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// photo tests
// ---------------------------------------------------------------------------

describe("handler - photo", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
    defaultChatId: "58687206",
  };

  it("sends photo", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler([
      "photo",
      "--chat", "58687206",
      "--photo", "https://example.com/image.jpg",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Photo sent successfully");

    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.photo).toBe("https://example.com/image.jpg");
  });

  it("includes caption", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    await handler([
      "photo",
      "--chat", "58687206",
      "--photo", "https://example.com/image.jpg",
      "--caption", "Check this out!",
    ]);

    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.caption).toBe("Check this out!");
  });

  it("errors when no photo specified", async () => {
    const handler = createHandler(config);
    const result = await handler(["photo", "--chat", "58687206"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No photo specified");
  });
});

// ---------------------------------------------------------------------------
// document tests
// ---------------------------------------------------------------------------

describe("handler - document", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
    defaultChatId: "58687206",
  };

  it("sends document", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler([
      "document",
      "--chat", "58687206",
      "--document", "https://example.com/report.pdf",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Document sent successfully");

    const curlArgs = mockCalls[0].args;
    const jsonPayload = curlArgs[curlArgs.indexOf("-d") + 1];
    const payload = JSON.parse(jsonPayload);
    expect(payload.document).toBe("https://example.com/report.pdf");
  });

  it("errors when no document specified", async () => {
    const handler = createHandler(config);
    const result = await handler(["document", "--chat", "58687206"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No document specified");
  });
});

// ---------------------------------------------------------------------------
// me (getMe) tests
// ---------------------------------------------------------------------------

describe("handler - me", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
  };

  it("returns bot info", async () => {
    mockResponse = {
      stdout: JSON.stringify({
        ok: true,
        result: {
          id: 1234567890,
          is_bot: true,
          first_name: "Test Bot",
          username: "test_bot",
        },
      }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["me"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Test Bot");
    expect(result.output).toContain("test_bot");
  });

  it("errors when botToken not configured", async () => {
    const handler = createHandler({});
    const result = await handler(["me"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("botToken not configured");
  });
});

// ---------------------------------------------------------------------------
// chat (getChat) tests
// ---------------------------------------------------------------------------

describe("handler - chat", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
    defaultChatId: "58687206",
  };

  it("returns chat info", async () => {
    mockResponse = {
      stdout: JSON.stringify({
        ok: true,
        result: {
          id: 58687206,
          type: "private",
          first_name: "John",
        },
      }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["chat", "--chat", "58687206"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("John");
    expect(result.output).toContain("private");
  });

  it("errors when no chat ID", async () => {
    const handler = createHandler({ botToken: "test-token" });
    const result = await handler(["chat"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No chat ID specified");
  });
});

// ---------------------------------------------------------------------------
// updates tests
// ---------------------------------------------------------------------------

describe("handler - updates", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
  };

  it("returns updates", async () => {
    mockResponse = {
      stdout: JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 123,
            message: {
              message_id: 1,
              chat: { id: 58687206 },
              text: "/start",
            },
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["updates", "--limit", "10"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("update_id");
    expect(result.output).toContain("58687206");
  });

  it("errors when botToken not configured", async () => {
    const handler = createHandler({});
    const result = await handler(["updates"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("botToken not configured");
  });
});

// ---------------------------------------------------------------------------
// Subcommand aliases
// ---------------------------------------------------------------------------

describe("handler - subcommand aliases", () => {
  beforeEach(() => {
    resetMock();
  });

  const config = {
    botToken: "test-token-12345",
    defaultChatId: "58687206",
  };

  it("accepts 'message' as alias for 'send'", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["message", "--text", "Hello!"]);

    expect(result.exitCode).toBe(0);
  });

  it("accepts 'msg' as alias for 'send'", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["msg", "--text", "Hello!"]);

    expect(result.exitCode).toBe(0);
  });

  it("accepts 'image' as alias for 'photo'", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["image", "--photo", "https://example.com/img.jpg"]);

    expect(result.exitCode).toBe(0);
  });

  it("accepts 'doc' as alias for 'document'", async () => {
    mockResponse = {
      stdout: JSON.stringify({ ok: true, result: { message_id: 1 } }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["doc", "--document", "https://example.com/file.pdf"]);

    expect(result.exitCode).toBe(0);
  });

  it("accepts 'bot' as alias for 'me'", async () => {
    mockResponse = {
      stdout: JSON.stringify({
        ok: true,
        result: { id: 123, first_name: "Bot" },
      }),
      stderr: "",
      exitCode: 0,
    };

    const handler = createHandler(config);
    const result = await handler(["bot"]);

    expect(result.exitCode).toBe(0);
  });
});
