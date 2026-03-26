import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createHandler,
  extractSubcommand,
  hasForcePushFlag,
  extractCloneUrl,
  normaliseRemoteUrl,
  remoteMatchesPattern,
  remoteAllowed,
  buildAuthEnv,
  buildIdentityEnv,
  type Executor,
  type ExecResult,
} from "../index.js";

// ---------------------------------------------------------------------------
// Fake executor
// ---------------------------------------------------------------------------

interface FakeCall {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

function makeExecutor(result: Partial<ExecResult> = {}): {
  executor: Executor;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
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

function makeHandler(
  config: Record<string, unknown> = {},
  executorResult: Partial<ExecResult> = {}
) {
  const { executor, calls } = makeExecutor(executorResult);
  const handler = createHandler(config, { executor });
  return { handler, calls };
}

const SESSION = {
  sessionKey: "test:123",
  channel: "test",
  agentName: "AGENTNAME",
  agentDir: "/home/beige/.beige/agents/AGENTNAME",
  workspaceDir: "/home/beige/.beige/agents/AGENTNAME/workspace",
};

// ---------------------------------------------------------------------------
// extractSubcommand
// ---------------------------------------------------------------------------

describe("extractSubcommand", () => {
  it("extracts simple subcommand", () => {
    expect(extractSubcommand(["status"])).toBe("status");
  });

  it("extracts subcommand after -C flag", () => {
    expect(extractSubcommand(["-C", "/some/path", "status"])).toBe("status");
  });

  it("extracts subcommand with args", () => {
    expect(extractSubcommand(["commit", "-m", "msg"])).toBe("commit");
  });

  it("returns null for empty args", () => {
    expect(extractSubcommand([])).toBeNull();
  });

  it("returns null for flags only", () => {
    expect(extractSubcommand(["--no-pager"])).toBeNull();
  });

  it("skips --git-dir flag and value", () => {
    expect(extractSubcommand(["--git-dir", "/repo/.git", "log"])).toBe("log");
  });
});

// ---------------------------------------------------------------------------
// hasForcePushFlag
// ---------------------------------------------------------------------------

describe("hasForcePushFlag", () => {
  it("detects --force", () => {
    expect(hasForcePushFlag(["push", "origin", "main", "--force"])).toBe(true);
  });

  it("detects -f", () => {
    expect(hasForcePushFlag(["push", "-f"])).toBe(true);
  });

  it("detects --force-with-lease", () => {
    expect(hasForcePushFlag(["push", "--force-with-lease"])).toBe(true);
  });

  it("detects --force-with-lease=<ref>", () => {
    expect(hasForcePushFlag(["push", "--force-with-lease=main:abc123"])).toBe(true);
  });

  it("returns false for normal push", () => {
    expect(hasForcePushFlag(["push", "origin", "main"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractCloneUrl
// ---------------------------------------------------------------------------

describe("extractCloneUrl", () => {
  it("extracts URL from clone args", () => {
    expect(extractCloneUrl(["clone", "git@github.com:myorg/myrepo.git"])).toBe(
      "git@github.com:myorg/myrepo.git"
    );
  });

  it("skips flags before URL", () => {
    expect(
      extractCloneUrl(["clone", "--depth", "1", "https://github.com/myorg/myrepo.git"])
    ).toBe("https://github.com/myorg/myrepo.git");
  });

  it("returns null when no URL present", () => {
    expect(extractCloneUrl(["clone"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normaliseRemoteUrl
// ---------------------------------------------------------------------------

describe("normaliseRemoteUrl", () => {
  it("strips https://", () => {
    expect(normaliseRemoteUrl("https://github.com/myorg/myrepo")).toBe(
      "github.com/myorg/myrepo"
    );
  });

  it("strips .git suffix", () => {
    expect(normaliseRemoteUrl("https://github.com/myorg/myrepo.git")).toBe(
      "github.com/myorg/myrepo"
    );
  });

  it("converts git@ SSH format", () => {
    expect(normaliseRemoteUrl("git@github.com:myorg/myrepo.git")).toBe(
      "github.com/myorg/myrepo"
    );
  });

  it("strips ssh:// prefix and converts git@ format", () => {
    expect(normaliseRemoteUrl("ssh://git@github.com/myorg/myrepo")).toBe(
      "github.com/myorg/myrepo"
    );
  });
});

// ---------------------------------------------------------------------------
// remoteMatchesPattern
// ---------------------------------------------------------------------------

describe("remoteMatchesPattern", () => {
  it("matches wildcard org pattern", () => {
    expect(
      remoteMatchesPattern("https://github.com/myorg/myrepo.git", "github.com/myorg/*")
    ).toBe(true);
  });

  it("rejects different org", () => {
    expect(
      remoteMatchesPattern("https://github.com/otherorg/myrepo.git", "github.com/myorg/*")
    ).toBe(false);
  });

  it("matches exact URL", () => {
    expect(
      remoteMatchesPattern("git@github.com:myorg/myrepo.git", "github.com/myorg/myrepo")
    ).toBe(true);
  });

  it("does not match subpath of exact pattern", () => {
    expect(
      remoteMatchesPattern(
        "https://github.com/myorg/myrepo/extra",
        "github.com/myorg/myrepo"
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remoteAllowed
// ---------------------------------------------------------------------------

describe("remoteAllowed", () => {
  it("allows all when pattern list is empty", () => {
    expect(remoteAllowed("https://github.com/anyone/anything", [])).toBe(true);
  });

  it("allows matching remote", () => {
    expect(
      remoteAllowed("https://github.com/myorg/myrepo", ["github.com/myorg/*"])
    ).toBe(true);
  });

  it("blocks non-matching remote", () => {
    expect(
      remoteAllowed("https://github.com/evil/steal", ["github.com/myorg/*"])
    ).toBe(false);
  });

  it("allows when any pattern matches", () => {
    expect(
      remoteAllowed("https://github.com/myorg/myrepo", [
        "github.com/otherorg/*",
        "github.com/myorg/*",
      ])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildIdentityEnv
// ---------------------------------------------------------------------------

describe("buildIdentityEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty object when no identity config", () => {
    expect(buildIdentityEnv(undefined)).toEqual({});
  });

  it("sets name and email from literals", () => {
    const env = buildIdentityEnv({ name: "Beige Agent", email: "agent@example.com" });
    expect(env.GIT_AUTHOR_NAME).toBe("Beige Agent");
    expect(env.GIT_COMMITTER_NAME).toBe("Beige Agent");
    expect(env.GIT_AUTHOR_EMAIL).toBe("agent@example.com");
    expect(env.GIT_COMMITTER_EMAIL).toBe("agent@example.com");
  });

  it("sets name and email from direct values", () => {
    const env = buildIdentityEnv({ name: "Test Agent", email: "test@example.com" });
    expect(env.GIT_AUTHOR_NAME).toBe("Test Agent");
    expect(env.GIT_COMMITTER_NAME).toBe("Test Agent");
    expect(env.GIT_AUTHOR_EMAIL).toBe("test@example.com");
    expect(env.GIT_COMMITTER_EMAIL).toBe("test@example.com");
  });

  it("sets only name", () => {
    const env = buildIdentityEnv({ name: "Test Agent" });
    expect(env.GIT_AUTHOR_NAME).toBe("Test Agent");
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it("sets only email", () => {
    const env = buildIdentityEnv({ email: "test@example.com" });
    expect(env.GIT_AUTHOR_EMAIL).toBe("test@example.com");
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
  });

  it("omits fields when not set", () => {
    const env = buildIdentityEnv({});
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildAuthEnv — SSH modes
// ---------------------------------------------------------------------------

describe("buildAuthEnv — ssh mode (per-agent defaults)", () => {
  it("builds GIT_SSH_COMMAND from agentDir", () => {
    const { env, cleanup } = buildAuthEnv(
      { auth: { mode: "ssh" } },
      { agentDir: "/beige/agents/AGENTNAME" }
    );
    expect(env.GIT_SSH_COMMAND).toContain("-i /beige/agents/AGENTNAME/ssh/id_ed25519");
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(env.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=/beige/agents/AGENTNAME/ssh/known_hosts");
    cleanup();
  });

  it("uses default mode when auth is absent", () => {
    const { env, cleanup } = buildAuthEnv({}, { agentDir: "/beige/agents/AGENTNAME" });
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    cleanup();
  });

  it("sets BatchMode and disables password auth", () => {
    const { env, cleanup } = buildAuthEnv(
      { auth: { mode: "ssh" } },
      { agentDir: "/beige/agents/AGENTNAME" }
    );
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(env.GIT_SSH_COMMAND).toContain("PasswordAuthentication=no");
    cleanup();
  });

  it("sets GIT_TERMINAL_PROMPT=0", () => {
    const { env, cleanup } = buildAuthEnv(
      { auth: { mode: "ssh" } },
      { agentDir: "/beige/agents/AGENTNAME" }
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    cleanup();
  });

  it("uses explicit known_hosts override when provided", () => {
    const { env, cleanup } = buildAuthEnv(
      {
        auth: {
          mode: "ssh",
          sshKnownHostsPath: "/custom/known_hosts",
        },
      },
      { agentDir: "/beige/agents/AGENTNAME" }
    );
    expect(env.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=/custom/known_hosts");
    cleanup();
  });
});

describe("buildAuthEnv — ssh mode (explicit overrides)", () => {
  it("uses provided sshKeyPath", () => {
    const { env, cleanup } = buildAuthEnv(
      {
        auth: {
          mode: "ssh",
          sshKeyPath: "/etc/keys/deploy_key",
          sshKnownHostsPath: "/etc/keys/known_hosts",
        },
      },
      {}
    );
    expect(env.GIT_SSH_COMMAND).toContain("-i /etc/keys/deploy_key");
    expect(env.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=/etc/keys/known_hosts");
    cleanup();
  });
});

describe("buildAuthEnv — https mode", () => {
  it("writes an askpass script and sets GIT_ASKPASS", () => {
    const { env, cleanup } = buildAuthEnv(
      { auth: { mode: "https", token: "ghp_test123" } },
      {}
    );
    expect(env.GIT_ASKPASS).toBeDefined();
    expect(env.GIT_ASKPASS).toContain("beige-git-askpass");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    cleanup();
  });

  it("cleanup removes the askpass script", async () => {
    const { env, cleanup } = buildAuthEnv(
      { auth: { mode: "https", token: "ghp_test123" } },
      {}
    );
    const scriptPath = env.GIT_ASKPASS!;
    const { existsSync } = await import("node:fs");
    expect(existsSync(scriptPath)).toBe(true);
    cleanup();
    expect(existsSync(scriptPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createHandler — no args
// ---------------------------------------------------------------------------

describe("no args", () => {
  it("returns usage text and exitCode 1", async () => {
    const { handler } = makeHandler();
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: git");
  });
});

// ---------------------------------------------------------------------------
// createHandler — always-blocked subcommands
// ---------------------------------------------------------------------------

describe("always-blocked subcommands", () => {
  it("blocks git config regardless of allowedCommands", async () => {
    const { handler, calls } = makeHandler({ allowedCommands: ["config", "status"] });
    const result = await handler(["config", "--get", "user.name"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("permanently blocked");
    expect(calls).toHaveLength(0);
  });

  it("blocks git filter-branch", async () => {
    const { handler, calls } = makeHandler({ allowedCommands: ["filter-branch"] });
    const result = await handler(["filter-branch", "--all"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("permanently blocked");
    expect(calls).toHaveLength(0);
  });

  it("blocks git fast-import", async () => {
    const { handler } = makeHandler({ allowedCommands: ["fast-import"] });
    const result = await handler(["fast-import"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("permanently blocked");
  });
});

// ---------------------------------------------------------------------------
// createHandler — allowedCommands
// ---------------------------------------------------------------------------

describe("allowedCommands", () => {
  it("permits subcommands in the allowlist", async () => {
    const { handler, calls } = makeHandler(
      { allowedCommands: ["status"] },
      { stdout: "nothing to commit" }
    );
    const result = await handler(["status"], undefined, SESSION);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("blocks subcommands not in the allowlist", async () => {
    const { handler, calls } = makeHandler({ allowedCommands: ["status"] });
    const result = await handler(["push", "origin", "main"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("push");
    expect(calls).toHaveLength(0);
  });

  it("uses DEFAULT_ALLOWED when allowedCommands is absent", async () => {
    const { handler } = makeHandler({}, { stdout: "ok" });
    // "status" is in DEFAULT_ALLOWED
    const result = await handler(["status"], undefined, SESSION);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createHandler — deniedCommands
// ---------------------------------------------------------------------------

describe("deniedCommands", () => {
  it("blocks denied subcommands even when in allowedCommands", async () => {
    const { handler, calls } = makeHandler({
      allowedCommands: ["push", "status"],
      deniedCommands: ["push"],
    });
    const result = await handler(["push"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(calls).toHaveLength(0);
  });

  it("does not block non-denied subcommands", async () => {
    const { handler } = makeHandler(
      { deniedCommands: ["push"] },
      { stdout: "on main" }
    );
    const result = await handler(["status"], undefined, SESSION);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createHandler — force-push protection
// ---------------------------------------------------------------------------

describe("force-push protection", () => {
  it("blocks --force by default", async () => {
    const { handler, calls } = makeHandler({}, {});
    const result = await handler(["push", "--force", "origin", "main"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("force-push is not allowed");
    expect(calls).toHaveLength(0);
  });

  it("blocks -f by default", async () => {
    const { handler, calls } = makeHandler({});
    const result = await handler(["push", "-f"]);
    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("blocks --force-with-lease by default", async () => {
    const { handler, calls } = makeHandler({});
    const result = await handler(["push", "--force-with-lease"]);
    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("allows force-push when explicitly enabled", async () => {
    const { handler, calls } = makeHandler(
      { allowForcePush: true },
      { stdout: "ok" }
    );
    const result = await handler(["push", "--force", "origin", "main"], undefined, SESSION);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createHandler — allowedRemotes (clone)
// ---------------------------------------------------------------------------

describe("allowedRemotes", () => {
  it("blocks clone to non-allowed remote", async () => {
    const { handler, calls } = makeHandler({
      allowedRemotes: ["github.com/myorg/*"],
    });
    const result = await handler(["clone", "https://github.com/evil/steal.git"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("does not match any allowed remote pattern");
    expect(calls).toHaveLength(0);
  });

  it("allows clone to matching remote", async () => {
    const { handler, calls } = makeHandler(
      { allowedRemotes: ["github.com/myorg/*"] },
      { stdout: "Cloning..." }
    );
    const result = await handler(
      ["clone", "https://github.com/myorg/myrepo.git"],
      undefined,
      SESSION
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("allows all remotes when allowedRemotes is not set", async () => {
    const { handler, calls } = makeHandler({}, { stdout: "Cloning..." });
    const result = await handler(
      ["clone", "https://github.com/anyone/anything.git"],
      undefined,
      SESSION
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createHandler — workspace scoping
// ---------------------------------------------------------------------------

describe("workspace scoping", () => {
  it("passes workspaceDir as cwd to executor", async () => {
    const { handler, calls } = makeHandler({}, { stdout: "ok" });
    await handler(["status"], undefined, SESSION);
    expect(calls[0].cwd).toBe(SESSION.workspaceDir);
  });

  it("falls back to process.cwd() when sessionContext is absent", async () => {
    const { handler, calls } = makeHandler({}, { stdout: "ok" });
    await handler(["status"]);
    expect(calls[0].cwd).toBe(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// createHandler — auth env is passed to executor
// ---------------------------------------------------------------------------

describe("auth env injection", () => {
  it("passes GIT_SSH_COMMAND to executor in ssh mode", async () => {
    const { handler, calls } = makeHandler({}, { stdout: "ok" });
    await handler(["status"], undefined, SESSION);
    expect(calls[0].env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(calls[0].env.GIT_SSH_COMMAND).toContain("AGENTNAME/ssh/id_ed25519");
  });

  it("does not pass SSH_AUTH_SOCK to executor", async () => {
    const { handler, calls } = makeHandler({}, { stdout: "ok" });
    await handler(["status"], undefined, SESSION);
    expect(calls[0].env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("does not pass SSH_AGENT_PID to executor", async () => {
    const { handler, calls } = makeHandler({}, { stdout: "ok" });
    await handler(["status"], undefined, SESSION);
    expect(calls[0].env.SSH_AGENT_PID).toBeUndefined();
  });

  it("passes identity env when configured", async () => {
    const { handler, calls } = makeHandler(
      { identity: { name: "Beige Agent", email: "agent@example.com" } },
      { stdout: "ok" }
    );
    await handler(["commit", "-m", "test"], undefined, SESSION);
    expect(calls[0].env.GIT_AUTHOR_NAME).toBe("Beige Agent");
    expect(calls[0].env.GIT_AUTHOR_EMAIL).toBe("agent@example.com");
    expect(calls[0].env.GIT_COMMITTER_NAME).toBe("Beige Agent");
    expect(calls[0].env.GIT_COMMITTER_EMAIL).toBe("agent@example.com");
  });
});

// ---------------------------------------------------------------------------
// createHandler — output formatting
// ---------------------------------------------------------------------------

describe("output formatting", () => {
  it("returns stdout on success", async () => {
    const { handler } = makeHandler({}, { stdout: "On branch main" });
    const result = await handler(["status"], undefined, SESSION);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("On branch main");
  });

  it("combines stdout and stderr on success (e.g. git clone progress)", async () => {
    const { handler } = makeHandler(
      {},
      { stdout: "Cloning into 'myrepo'...", stderr: "remote: Counting objects: 10" }
    );
    const result = await handler(
      ["clone", "https://github.com/myorg/myrepo.git"],
      undefined,
      SESSION
    );
    expect(result.output).toContain("Cloning into");
    expect(result.output).toContain("Counting objects");
  });

  it("returns '(no output)' when both streams are empty on success", async () => {
    const { handler } = makeHandler({}, { stdout: "", stderr: "", exitCode: 0 });
    const result = await handler(["add", "."], undefined, SESSION);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("(no output)");
  });

  it("includes stderr in failure output", async () => {
    const { handler } = makeHandler(
      {},
      { stderr: "error: pathspec 'missing' did not match any file", exitCode: 128 }
    );
    const result = await handler(["checkout", "missing"], undefined, SESSION);
    expect(result.exitCode).toBe(128);
    expect(result.output).toContain("pathspec 'missing'");
  });

  it("returns fallback message when both streams are empty on failure", async () => {
    const { handler } = makeHandler({}, { stdout: "", stderr: "", exitCode: 1 });
    const result = await handler(["push"], undefined, SESSION);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("git exited with code 1");
  });
});
