import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { createHandler } from "../index.js";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import { assertValidToolManifest, assertSuccess, assertFailure } from "../../../test-utils/assertions.js";
import type { ExecResult, Executor } from "../index.js";

const TOOL_DIR = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Fake executor for integration flows
// ---------------------------------------------------------------------------

function fakeExecutor(result: Partial<ExecResult> = {}): {
  executor: Executor;
  calls: Array<{ args: string[]; env: Record<string, string>; cwd: string }>;
} {
  const calls: Array<{ args: string[]; env: Record<string, string>; cwd: string }> = [];
  const executor: Executor = async (args, env, cwd) => {
    calls.push({ args: [...args], env: { ...env }, cwd });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  };
  return { executor, calls };
}

const SESSION = {
  sessionKey: "tui:test",
  channel: "tui",
  agentName: "AGENTNAME",
  agentDir: "/beige/agents/AGENTNAME",
  workspaceDir: "/beige/agents/AGENTNAME/workspace",
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("plugin.json", () => {
  it("is valid and complete", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    assertValidToolManifest(manifest);
  });

  it("is named 'git'", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    expect(manifest.name).toBe("git");
  });

  it("provides the git tool", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    expect(manifest.provides).toEqual({ tools: ["git"] });
  });

  it("has at least one documented command", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    expect(manifest.commands).toBeDefined();
    expect(manifest.commands!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Handler lifecycle
// ---------------------------------------------------------------------------

describe("createHandler", () => {
  it("returns a callable function", () => {
    const handler = createHandler({});
    expect(typeof handler).toBe("function");
  });

  it("accepts an empty config object", () => {
    expect(() => createHandler({})).not.toThrow();
  });

  it("accepts full config without throwing", () => {
    expect(() =>
      createHandler({
        allowedCommands: ["status", "commit", "push"],
        deniedCommands: ["push"],
        allowedRemotes: ["github.com/myorg/*"],
        allowForcePush: false,
        identity: { name: "Agent", email: "agent@example.com" },
        auth: { mode: "ssh" },
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Typical workflows
// ---------------------------------------------------------------------------

describe("typical git workflow", () => {
  it("status → add → commit → push succeeds end-to-end", async () => {
    const { executor, calls } = fakeExecutor({ stdout: "ok", exitCode: 0 });
    const handler = createHandler(
      {
        allowedCommands: ["status", "add", "commit", "push"],
        identity: { name: "Beige Agent", email: "beige-agent@example.com" },
        auth: { mode: "ssh" },
      },
      { executor }
    );

    const status = await handler(["status"], undefined, SESSION);
    assertSuccess(status);

    const add = await handler(["add", "."], undefined, SESSION);
    assertSuccess(add);

    const commit = await handler(["commit", "-m", "feat: implement feature"], undefined, SESSION);
    assertSuccess(commit);

    const push = await handler(["push", "origin", "main"], undefined, SESSION);
    assertSuccess(push);

    expect(calls).toHaveLength(4);
    expect(calls[2].args).toContain("commit");
    expect(calls[2].env.GIT_AUTHOR_NAME).toBe("Beige Agent");
    expect(calls[3].args).toContain("push");
  });

  it("clone respects allowedRemotes", async () => {
    const { executor } = fakeExecutor({ stdout: "Cloning...", exitCode: 0 });
    const handler = createHandler(
      { allowedRemotes: ["github.com/myorg/*"] },
      { executor }
    );

    const allowed = await handler(
      ["clone", "https://github.com/myorg/myrepo.git"],
      undefined,
      SESSION
    );
    assertSuccess(allowed);

    const blocked = await handler(
      ["clone", "https://github.com/evil/exfil.git"],
      undefined,
      SESSION
    );
    assertFailure(blocked);
    expect(blocked.output).toContain("does not match");
  });

  it("git config is always blocked even with explicit allowedCommands", async () => {
    const { executor, calls } = fakeExecutor({ stdout: "would-leak", exitCode: 0 });
    const handler = createHandler(
      { allowedCommands: ["config", "status"] },
      { executor }
    );

    const result = await handler(["config", "--global", "core.sshCommand", "cat /etc/passwd"]);
    assertFailure(result);
    expect(result.output).toContain("permanently blocked");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-agent SSH isolation
// ---------------------------------------------------------------------------

describe("per-agent SSH isolation", () => {
  it("two agents with different agentDirs get different SSH keys", async () => {
    const { executor: exec1, calls: calls1 } = fakeExecutor({ stdout: "ok" });
    const { executor: exec2, calls: calls2 } = fakeExecutor({ stdout: "ok" });

    const handler1 = createHandler({ auth: { mode: "ssh" } }, { executor: exec1 });
    const handler2 = createHandler({ auth: { mode: "ssh" } }, { executor: exec2 });

    const session1 = { ...SESSION, agentName: "AGENTNAME_A", agentDir: "/beige/agents/AGENTNAME_A" };
    const session2 = { ...SESSION, agentName: "AGENTNAME_B", agentDir: "/beige/agents/AGENTNAME_B" };

    await handler1(["status"], undefined, session1);
    await handler2(["status"], undefined, session2);

    const sshCmd1 = calls1[0].env.GIT_SSH_COMMAND;
    const sshCmd2 = calls2[0].env.GIT_SSH_COMMAND;

    expect(sshCmd1).toContain("/beige/agents/AGENTNAME_A/ssh/id_ed25519");
    expect(sshCmd2).toContain("/beige/agents/AGENTNAME_B/ssh/id_ed25519");
    expect(sshCmd1).not.toBe(sshCmd2);
  });

  it("ssh mode never passes SSH_AUTH_SOCK", async () => {
    const { executor, calls } = fakeExecutor({ stdout: "ok" });
    const handler = createHandler({ auth: { mode: "ssh" } }, { executor });
    await handler(["status"], undefined, SESSION);
    expect(calls[0].env.SSH_AUTH_SOCK).toBeUndefined();
    expect(calls[0].env.SSH_AGENT_PID).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("error propagation", () => {
  it("surfaces git error output on failure", async () => {
    const { executor } = fakeExecutor({
      stderr: "error: failed to push some refs to 'github.com/myorg/myrepo'",
      exitCode: 1,
    });
    const handler = createHandler({}, { executor });
    const result = await handler(["push", "origin", "main"], undefined, SESSION);
    assertFailure(result);
    expect(result.output).toContain("failed to push");
  });

  it("returns fallback message when git produces no output on failure", async () => {
    const { executor } = fakeExecutor({ stdout: "", stderr: "", exitCode: 128 });
    const handler = createHandler({}, { executor });
    const result = await handler(["push"], undefined, SESSION);
    assertFailure(result);
    expect(result.output).toContain("git exited with code 128");
  });
});
