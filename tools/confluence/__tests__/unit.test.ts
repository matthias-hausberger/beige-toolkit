/**
 * Unit tests for the confluence tool handler.
 *
 * All tests use an injected executor stub — no real confluence process is
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
    stderr: "confluence not found on PATH. Install it with: brew install pchuri/tap/confluence-cli  or  npm install -g confluence-cli",
    exitCode: 127,
  });
}

// ---------------------------------------------------------------------------
// extractCommandPath
// ---------------------------------------------------------------------------

describe("extractCommandPath", () => {
  it("extracts single-token command", () => {
    expect(extractCommandPath(["read"])).toBe("read");
  });

  it("extracts two-token command path (profile subcommand)", () => {
    expect(extractCommandPath(["profile", "list"])).toBe("profile list");
  });

  it("profile captures second token, stops before positional arg", () => {
    expect(extractCommandPath(["profile", "use", "staging"])).toBe("profile use");
  });

  it("stops after subcommand — positional args are not subcommand tokens", () => {
    // "my query" is a positional arg, not a second subcommand token
    expect(extractCommandPath(["search", "my query", "--limit", "5"])).toBe("search");
  });

  it("stops at first flag for single-token paths", () => {
    expect(extractCommandPath(["read", "--format", "markdown"])).toBe("read");
  });

  it("returns empty string for flag-only args", () => {
    expect(extractCommandPath(["--help"])).toBe("");
  });

  it("returns empty string for empty args", () => {
    expect(extractCommandPath([])).toBe("");
  });

  it("stops at -- separator", () => {
    expect(extractCommandPath(["search", "--", "query"])).toBe("search");
  });

  it("skips leading --profile flag and its value", () => {
    // "123" is a page ID positional arg, not part of the command path
    expect(extractCommandPath(["--profile", "staging", "read", "123"])).toBe("read");
  });

  it("skips --profile and still captures two-token profile path", () => {
    expect(extractCommandPath(["--profile", "staging", "profile", "list"])).toBe("profile list");
  });

  it("extracts create-child as single token — positional args ignored", () => {
    // "My Page" and "123456" are positional args, not subcommand tokens
    expect(extractCommandPath(["create-child", "My Page", "123456"])).toBe("create-child");
  });
});

// ---------------------------------------------------------------------------
// checkPermission
// ---------------------------------------------------------------------------

describe("checkPermission — no config (default: all allowed)", () => {
  it("allows read", () => {
    expect(checkPermission("read", {}, false).allowed).toBe(true);
  });

  it("allows search", () => {
    expect(checkPermission("search", {}, false).allowed).toBe(true);
  });

  it("allows create", () => {
    expect(checkPermission("create", {}, false).allowed).toBe(true);
  });

  it("allows create-child", () => {
    expect(checkPermission("create-child", {}, false).allowed).toBe(true);
  });

  it("allows update", () => {
    expect(checkPermission("update", {}, false).allowed).toBe(true);
  });

  it("allows delete", () => {
    expect(checkPermission("delete", {}, false).allowed).toBe(true);
  });

  it("allows profile list", () => {
    expect(checkPermission("profile list", {}, false).allowed).toBe(true);
  });

  it("allows profile use", () => {
    expect(checkPermission("profile use", {}, false).allowed).toBe(true);
  });

  it("allows stats", () => {
    expect(checkPermission("stats", {}, false).allowed).toBe(true);
  });
});

describe("checkPermission — denyCommands", () => {
  it("blocks exact match", () => {
    const r = checkPermission("delete", { denyCommands: "delete" }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("delete");
  });

  it("prefix 'create' blocks 'create-child' too", () => {
    expect(checkPermission("create", { denyCommands: "create" }, true).allowed).toBe(false);
    expect(checkPermission("create-child", { denyCommands: "create" }, true).allowed).toBe(false);
  });

  it("prefix 'create' does not block 'read'", () => {
    expect(checkPermission("read", { denyCommands: "create" }, true).allowed).toBe(true);
  });

  it("blocks prefix match — 'profile' covers all profile subcommands", () => {
    expect(checkPermission("profile list", { denyCommands: "profile" }, true).allowed).toBe(false);
    expect(checkPermission("profile use", { denyCommands: "profile" }, true).allowed).toBe(false);
    expect(checkPermission("profile add", { denyCommands: "profile" }, true).allowed).toBe(false);
  });

  it("exact two-token deny does not over-block sibling", () => {
    expect(checkPermission("profile use", { denyCommands: "profile list" }, true).allowed).toBe(true);
    expect(checkPermission("profile list", { denyCommands: "profile list" }, true).allowed).toBe(false);
  });

  it("accepts array of denyCommands", () => {
    const config = { denyCommands: ["create", "update", "delete"] };
    expect(checkPermission("create", config, true).allowed).toBe(false);
    expect(checkPermission("update", config, true).allowed).toBe(false);
    expect(checkPermission("delete", config, true).allowed).toBe(false);
    expect(checkPermission("read", config, true).allowed).toBe(true);
  });

  it("deny beats allow", () => {
    const config = {
      allowCommands: ["delete"],
      denyCommands: ["delete"],
    };
    expect(checkPermission("delete", config, true).allowed).toBe(false);
  });
});

describe("checkPermission — allowCommands", () => {
  it("allows command in allowlist", () => {
    const r = checkPermission("read", { allowCommands: ["read", "search"] }, true);
    expect(r.allowed).toBe(true);
  });

  it("blocks command not in allowlist", () => {
    const r = checkPermission("delete", { allowCommands: ["read", "search"] }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not in allowCommands");
    expect(r.reason).toContain("read");
  });

  it("prefix allowlist entry covers subcommands — 'create' allows 'create-child'", () => {
    const config = { allowCommands: "create" };
    expect(checkPermission("create", config, true).allowed).toBe(true);
    expect(checkPermission("create-child", config, true).allowed).toBe(true);
    expect(checkPermission("delete", config, true).allowed).toBe(false);
  });

  it("empty allowCommands (omitted) allows everything", () => {
    expect(checkPermission("delete", {}, true).allowed).toBe(true);
  });

  it("case-insensitive matching", () => {
    expect(checkPermission("Delete", { denyCommands: "delete" }, true).allowed).toBe(false);
    expect(checkPermission("Read", { allowCommands: "read" }, true).allowed).toBe(true);
  });

  it("'profile' prefix in allowlist covers both 'profile list' and 'profile use'", () => {
    const config = { allowCommands: ["read", "profile"] };
    expect(checkPermission("profile list", config, true).allowed).toBe(true);
    expect(checkPermission("profile use", config, true).allowed).toBe(true);
    expect(checkPermission("create", config, true).allowed).toBe(false);
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
    expect(result.output).toContain("confluence");
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
      { denyCommands: ["delete", "update"] },
      { executor: exec }
    );
    const result = await handler(["delete", "123456789", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("delete");
    expect(exec.calls).toHaveLength(0);
  });

  it("blocks command not in allowlist and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { allowCommands: ["read", "search"] },
      { executor: exec }
    );
    const result = await handler(["create", "My Page", "SPACE"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows permitted command and invokes executor", async () => {
    const exec = makeExecutor({ stdout: "Page content here", exitCode: 0 });
    const handler = createHandler(
      { allowCommands: ["read", "search"] },
      { executor: exec }
    );
    const result = await handler(["read", "123456789"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Page content here");
    expect(exec.calls).toHaveLength(1);
  });

  it("allows all commands when no config provided (empty default denylist)", async () => {
    const exec = makeExecutor({ stdout: "done", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["delete", "123456789", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
  });

  it("does not apply default denylist when config explicitly provided", async () => {
    const exec = makeExecutor({ stdout: "ok", exitCode: 0 });
    // Providing only a timeout still counts as explicit config
    const handler = createHandler({ timeout: 10 }, { executor: exec });
    const result = await handler(["delete", "123456789", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Handler — executor invocation
// ---------------------------------------------------------------------------

describe("handler — executor invocation", () => {
  it("passes args through to confluence unchanged", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["search", "API documentation", "--limit", "5"]);
    expect(exec.calls[0].cmd).toBe("confluence");
    expect(exec.calls[0].args).toEqual(["search", "API documentation", "--limit", "5"]);
  });

  it("passes exit code from executor through", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "page not found", exitCode: 1 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "999999"]);
    expect(result.exitCode).toBe(1);
  });

  it("combines stdout and stderr in output", async () => {
    const exec = makeExecutor({ stdout: "some output", stderr: "some warning", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.output).toContain("some output");
    expect(result.output).toContain("some warning");
  });

  it("returns (no output) when both stdout and stderr are empty", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.output).toBe("(no output)");
  });

  it("surfaces confluence not-found error clearly", async () => {
    const handler = createHandler({}, { executor: makeNotFoundExecutor() });
    const result = await handler(["read", "123456789"]);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Handler — --help passthrough
// ---------------------------------------------------------------------------

describe("handler — --help passthrough", () => {
  it("passes --help through even though no command path is extracted", async () => {
    const exec = makeExecutor({ stdout: "Usage: confluence ...", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls[0].args).toEqual(["--help"]);
  });

  it("passes subcommand --help through", async () => {
    const exec = makeExecutor({ stdout: "Usage: confluence read ...", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    await handler(["read", "--help"]);
    expect(exec.calls[0].args).toEqual(["read", "--help"]);
  });
});

// ---------------------------------------------------------------------------
// Handler — default profile injection
// ---------------------------------------------------------------------------

describe("handler — profile injection", () => {
  it("prepends --profile when configured and not in args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ profile: "production" }, { executor: exec });
    await handler(["search", "my term"]);
    expect(exec.calls[0].args).toEqual(["--profile", "production", "search", "my term"]);
  });

  it("does not duplicate --profile if already in args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ profile: "production" }, { executor: exec });
    await handler(["--profile", "staging", "search", "my term"]);
    const profileCount = exec.calls[0].args.filter((a) => a === "--profile").length;
    expect(profileCount).toBe(1);
    // The agent-provided value wins
    expect(exec.calls[0].args[exec.calls[0].args.indexOf("--profile") + 1]).toBe("staging");
  });

  it("does not inject --profile when not configured", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["read", "123456789"]);
    expect(exec.calls[0].args).not.toContain("--profile");
  });

  it("permission check sees command after --profile is skipped", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { denyCommands: ["delete"], profile: "production" },
      { executor: exec }
    );
    // Agent passes --profile themselves before the subcommand
    const result = await handler(["--profile", "staging", "delete", "123"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });
});
