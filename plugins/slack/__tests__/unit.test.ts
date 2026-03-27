/**
 * Unit tests for the slack tool handler.
 *
 * All tests use an injected executor stub — no real slackcli process is
 * spawned.  Tests are fast and deterministic.
 */

import { describe, it, expect } from "vitest";
import {
  createHandler,
  extractCommandPath,
  checkPermission,
  type ExecResult,
  type Executor,
} from "../index.js";

// ---------------------------------------------------------------------------
// Stub executor
// ---------------------------------------------------------------------------

function makeExecutor(
  result: Partial<ExecResult> = {}
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const executor: Executor & { calls: typeof calls } = Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {
        stdout: result.stdout ?? "ok",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    { calls }
  );
  return executor;
}

function makeNotFoundExecutor(): Executor {
  return async () => ({
    stdout: "",
    stderr: "slackcli not found on PATH. Install it with: npm install -g slackcli",
    exitCode: 127,
  });
}

// ---------------------------------------------------------------------------
// extractCommandPath
// ---------------------------------------------------------------------------

describe("extractCommandPath", () => {
  it("extracts single-token command", () => {
    expect(extractCommandPath(["auth"])).toBe("auth");
  });

  it("extracts two-token command path", () => {
    expect(extractCommandPath(["conversations", "list"])).toBe("conversations list");
  });

  it("caps at two tokens even with more subcommands", () => {
    expect(extractCommandPath(["conversations", "list", "extra"])).toBe("conversations list");
  });

  it("stops at flag boundary", () => {
    expect(extractCommandPath(["messages", "send", "--recipient-id", "C1"])).toBe("messages send");
  });

  it("stops at first flag for single-token paths", () => {
    expect(extractCommandPath(["auth", "--help"])).toBe("auth");
  });

  it("returns empty string for flag-only args", () => {
    expect(extractCommandPath(["--help"])).toBe("");
  });

  it("returns empty string for empty args", () => {
    expect(extractCommandPath([])).toBe("");
  });

  it("stops at -- separator", () => {
    expect(extractCommandPath(["messages", "--", "send"])).toBe("messages");
  });

  it("extracts help subcommand", () => {
    expect(extractCommandPath(["conversations", "help"])).toBe("conversations help");
  });
});

// ---------------------------------------------------------------------------
// checkPermission
// ---------------------------------------------------------------------------

describe("checkPermission — no config (default denylist)", () => {
  it("allows conversations list", () => {
    expect(checkPermission("conversations list", {}, false).allowed).toBe(true);
  });

  it("allows conversations read", () => {
    expect(checkPermission("conversations read", {}, false).allowed).toBe(true);
  });

  it("allows messages send", () => {
    // messages send is NOT in the default denylist — must be explicitly denied
    expect(checkPermission("messages send", {}, false).allowed).toBe(true);
  });

  it("allows auth list", () => {
    expect(checkPermission("auth list", {}, false).allowed).toBe(true);
  });

  it("blocks auth login", () => {
    const r = checkPermission("auth login", {}, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("auth login");
  });

  it("blocks auth login-browser", () => {
    expect(checkPermission("auth login-browser", {}, false).allowed).toBe(false);
  });

  it("blocks auth logout", () => {
    expect(checkPermission("auth logout", {}, false).allowed).toBe(false);
  });

  it("blocks auth remove", () => {
    expect(checkPermission("auth remove", {}, false).allowed).toBe(false);
  });

  it("blocks auth extract-tokens", () => {
    expect(checkPermission("auth extract-tokens", {}, false).allowed).toBe(false);
  });

  it("blocks auth parse-curl", () => {
    expect(checkPermission("auth parse-curl", {}, false).allowed).toBe(false);
  });

  it("blocks update", () => {
    expect(checkPermission("update", {}, false).allowed).toBe(false);
  });
});

describe("checkPermission — denyCommands", () => {
  it("blocks exact match", () => {
    const r = checkPermission("messages send", { denyCommands: "messages send" }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("messages send");
  });

  it("blocks prefix match — 'messages' covers all messages subcommands", () => {
    expect(checkPermission("messages send", { denyCommands: "messages" }, true).allowed).toBe(false);
    expect(checkPermission("messages react", { denyCommands: "messages" }, true).allowed).toBe(false);
    expect(checkPermission("messages draft", { denyCommands: "messages" }, true).allowed).toBe(false);
  });

  it("prefix match does not over-block — 'messages send' does not block 'messages react'", () => {
    expect(checkPermission("messages react", { denyCommands: "messages send" }, true).allowed).toBe(true);
    expect(checkPermission("messages draft", { denyCommands: "messages send" }, true).allowed).toBe(true);
  });

  it("accepts array of denyCommands", () => {
    const config = { denyCommands: ["messages send", "auth login"] };
    expect(checkPermission("messages send", config, true).allowed).toBe(false);
    expect(checkPermission("auth login", config, true).allowed).toBe(false);
    expect(checkPermission("messages react", config, true).allowed).toBe(true);
  });

  it("deny beats allow", () => {
    const config = {
      allowCommands: ["messages send"],
      denyCommands: ["messages send"],
    };
    expect(checkPermission("messages send", config, true).allowed).toBe(false);
  });
});

describe("checkPermission — allowCommands", () => {
  it("allows command in allowlist", () => {
    const r = checkPermission("conversations list", { allowCommands: ["conversations list"] }, true);
    expect(r.allowed).toBe(true);
  });

  it("blocks command not in allowlist", () => {
    const r = checkPermission("messages send", { allowCommands: ["conversations list"] }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not in allowCommands");
    expect(r.reason).toContain("conversations list");
  });

  it("prefix allowlist entry covers subcommands", () => {
    const config = { allowCommands: "conversations" };
    expect(checkPermission("conversations list", config, true).allowed).toBe(true);
    expect(checkPermission("conversations read", config, true).allowed).toBe(true);
    expect(checkPermission("messages send", config, true).allowed).toBe(false);
  });

  it("empty allowCommands (omitted) allows everything", () => {
    expect(checkPermission("messages send", {}, true).allowed).toBe(true);
  });

  it("case-insensitive matching", () => {
    expect(checkPermission("Messages Send", { denyCommands: "messages send" }, true).allowed).toBe(false);
    expect(checkPermission("Conversations List", { allowCommands: "conversations list" }, true).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler — no args
// ---------------------------------------------------------------------------

describe("handler — no args", () => {
  it("returns usage when called with empty args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Handler — permission enforcement
// ---------------------------------------------------------------------------

describe("handler — permission enforcement", () => {
  it("blocks denied command and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { denyCommands: "messages send" },
      { executor: exec }
    );
    const result = await handler(["messages", "send", "--recipient-id", "C1", "--message", "hi"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("messages send");
    expect(exec.calls).toHaveLength(0);
  });

  it("blocks command not in allowlist and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { allowCommands: ["conversations list"] },
      { executor: exec }
    );
    const result = await handler(["messages", "send", "--recipient-id", "C1", "--message", "hi"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows permitted command and invokes executor", async () => {
    const exec = makeExecutor({ stdout: "channel-list-output", exitCode: 0 });
    const handler = createHandler(
      { allowCommands: ["conversations list", "messages react"] },
      { executor: exec }
    );
    const result = await handler(["conversations", "list", "--limit", "10"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("channel-list-output");
    expect(exec.calls).toHaveLength(1);
  });

  it("applies default denylist when no config provided", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["auth", "login"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("does not apply default denylist when config explicitly provided", async () => {
    const exec = makeExecutor({ stdout: "ok", exitCode: 0 });
    // User explicitly configured the tool (with only a timeout) — default
    // denylist should NOT be applied; auth login should be allowed.
    const handler = createHandler({ timeout: 10 }, { executor: exec });
    const result = await handler(["auth", "login"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Handler — executor invocation
// ---------------------------------------------------------------------------

describe("handler — executor invocation", () => {
  it("passes args through to slackcli unchanged", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["conversations", "list", "--limit", "20", "--exclude-archived"]);
    expect(exec.calls[0].cmd).toBe("slackcli");
    expect(exec.calls[0].args).toEqual(["conversations", "list", "--limit", "20", "--exclude-archived"]);
  });

  it("passes exit code from executor through", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "not found", exitCode: 1 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["conversations", "list"]);
    expect(result.exitCode).toBe(1);
  });

  it("combines stdout and stderr in output", async () => {
    const exec = makeExecutor({ stdout: "some output", stderr: "some warning", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["conversations", "list"]);
    expect(result.output).toContain("some output");
    expect(result.output).toContain("some warning");
  });

  it("returns (no output) when both stdout and stderr are empty", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["conversations", "list"]);
    expect(result.output).toBe("(no output)");
  });

  it("surfaces slackcli not-found error clearly", async () => {
    const handler = createHandler({}, { executor: makeNotFoundExecutor() });
    const result = await handler(["conversations", "list"]);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Handler — --help passthrough
// ---------------------------------------------------------------------------

describe("handler — --help passthrough", () => {
  it("passes --help through even though no command path is extracted", async () => {
    const exec = makeExecutor({ stdout: "Usage: slackcli ...", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls[0].args).toEqual(["--help"]);
  });

  it("passes subcommand --help through", async () => {
    const exec = makeExecutor({ stdout: "Usage: slackcli messages ...", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    await handler(["messages", "--help"]);
    expect(exec.calls[0].args).toEqual(["messages", "--help"]);
  });
});

// ---------------------------------------------------------------------------
// Handler — default workspace injection
// ---------------------------------------------------------------------------

describe("handler — workspace injection", () => {
  it("appends --workspace when configured and not in args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ workspace: "my-team" }, { executor: exec });
    await handler(["conversations", "list"]);
    expect(exec.calls[0].args).toContain("--workspace");
    expect(exec.calls[0].args).toContain("my-team");
  });

  it("does not duplicate --workspace if already in args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ workspace: "my-team" }, { executor: exec });
    await handler(["conversations", "list", "--workspace", "other-team"]);
    const wsCount = exec.calls[0].args.filter((a) => a === "--workspace").length;
    expect(wsCount).toBe(1);
    // The agent-provided value wins
    expect(exec.calls[0].args[exec.calls[0].args.indexOf("--workspace") + 1]).toBe("other-team");
  });

  it("does not inject --workspace when not configured", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["conversations", "list"]);
    expect(exec.calls[0].args).not.toContain("--workspace");
  });
});
