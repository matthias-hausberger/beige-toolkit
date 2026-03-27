/**
 * Integration tests for the slack tool.
 *
 * Covers manifest validity and end-to-end permission + executor flows.
 * No real slackcli process is spawned.
 */

import { describe, it, expect } from "vitest";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import { assertValidToolManifest } from "../../../test-utils/assertions.js";
import { createHandler, type Executor } from "../index.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("tool manifest", () => {
  const manifest = loadToolManifest("plugins/slack");

  it("is valid", () => {
    assertValidToolManifest(manifest);
  });

  it("has name slack", () => {
    expect(manifest.name).toBe("slack");
  });


  it("lists at least one command example", () => {
    expect(manifest.commands?.length).toBeGreaterThan(0);
  });

  it("commands cover conversations, messages, and auth", () => {
    const cmds = manifest.commands?.join(" ") ?? "";
    expect(cmds).toContain("conversations");
    expect(cmds).toContain("messages");
    expect(cmds).toContain("auth");
  });
});

// ---------------------------------------------------------------------------
// Stub executor
// ---------------------------------------------------------------------------

function makeExecutor(
  response: string = "ok",
  exitCode = 0
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: response, stderr: "", exitCode };
    },
    { calls }
  );
}

// ---------------------------------------------------------------------------
// Read-only agent (denyCommands: messages send + messages draft)
// ---------------------------------------------------------------------------

describe("read-only agent config", () => {
  const config = {
    denyCommands: ["messages send", "messages draft"],
  };

  it("can list conversations", async () => {
    const exec = makeExecutor("channel-a\nchannel-b");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["conversations", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("channel-a");
  });

  it("can read conversation history", async () => {
    const exec = makeExecutor("message 1\nmessage 2");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["conversations", "read", "C12345", "--limit", "10"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("message 1");
  });

  it("can add reactions", async () => {
    const exec = makeExecutor("reaction added");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["messages", "react", "--channel-id", "C1", "--timestamp", "123.456", "--emoji", "thumbsup"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls[0].args[0]).toBe("messages");
    expect(exec.calls[0].args[1]).toBe("react");
  });

  it("cannot send messages", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["messages", "send", "--recipient-id", "C1", "--message", "hi"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot create drafts", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["messages", "draft", "--recipient-id", "C1", "--message", "draft"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Notification-only agent (allowCommands: messages send only)
// ---------------------------------------------------------------------------

describe("notification-only agent config", () => {
  const config = {
    allowCommands: ["messages send"],
  };

  it("can send messages", async () => {
    const exec = makeExecutor("message sent");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["messages", "send", "--recipient-id", "C1", "--message", "alert!"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("message sent");
  });

  it("cannot list conversations", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["conversations", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot read message history", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["conversations", "read", "C1"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Default denylist (no config)
// ---------------------------------------------------------------------------

describe("default denylist — no config", () => {
  it("blocks auth login", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["auth", "login", "--token", "xoxb-xxx"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("blocks auth logout", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["auth", "logout"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("blocks update", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["update", "check"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("allows conversations list", async () => {
    const exec = makeExecutor("channels");
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["conversations", "list"]);
    expect(result.exitCode).toBe(0);
  });

  it("allows messages send (not in default denylist)", async () => {
    const exec = makeExecutor("sent");
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["messages", "send", "--recipient-id", "C1", "--message", "hi"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deny beats allow
// ---------------------------------------------------------------------------

describe("deny beats allow", () => {
  it("denyCommands overrides allowCommands for the same path", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      {
        allowCommands: ["messages send", "conversations list"],
        denyCommands: ["messages send"],
      },
      { executor: exec }
    );
    const denied = await handler(["messages", "send", "--recipient-id", "C1", "--message", "hi"]);
    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("Permission denied");

    const allowed = await handler(["conversations", "list"]);
    expect(allowed.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exit code passthrough
// ---------------------------------------------------------------------------

describe("exit code passthrough", () => {
  it("passes non-zero exit code from slackcli through unchanged", async () => {
    const exec = makeExecutor("Error: channel not found", 1);
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["conversations", "read", "INVALID"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("channel not found");
  });
});
