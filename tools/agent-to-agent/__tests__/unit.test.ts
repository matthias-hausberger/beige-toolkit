/**
 * Unit tests for the agent-to-agent tool handler.
 *
 * All tests use injected stubs — no real AgentManager, SessionStore, or beige
 * config objects are needed.  Tests are deterministic and run in milliseconds.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createHandler,
  type AgentManagerLike,
  type SessionStoreLike,
  type SessionEntryLike,
  type BeigeConfigLike,
} from "../index.js";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makeAgentManager(response = "All looks good."): AgentManagerLike & { calls: Array<{ sessionKey: string; agentName: string; message: string }> } {
  const calls: Array<{ sessionKey: string; agentName: string; message: string }> = [];
  return {
    calls,
    async prompt(sessionKey, agentName, message) {
      calls.push({ sessionKey, agentName, message });
      return response;
    },
  };
}

function makeSessionStore(
  entries: Record<string, SessionEntryLike> = {}
): SessionStoreLike & { created: Array<{ key: string; agentName: string; metadata?: Record<string, unknown> }> } {
  const created: Array<{ key: string; agentName: string; metadata?: Record<string, unknown> }> = [];
  const map = { ...entries };
  return {
    created,
    getEntry(key) {
      return map[key];
    },
    createSession(key, agentName, metadata) {
      created.push({ key, agentName, metadata });
      map[key] = { agentName, metadata };
      return `/fake/sessions/${agentName}/${key}.jsonl`;
    },
  };
}

function makeConfig(overrides: Partial<BeigeConfigLike> = {}): BeigeConfigLike {
  return {
    agents: { coder: {}, reviewer: {}, assistant: {} },
    ...overrides,
  };
}

function makeContext(
  agentManager: AgentManagerLike,
  sessionStore: SessionStoreLike,
  beigeConfig: BeigeConfigLike
) {
  return {
    agentManagerRef: { current: agentManager },
    sessionStore,
    beigeConfig,
  };
}

// Simulate a top-level session (no metadata = depth 0)
const TOP_LEVEL_SESSION = "tui:coder:default";
const TOP_LEVEL_ENTRY: SessionEntryLike = { agentName: "coder" };

// ---------------------------------------------------------------------------
// Gateway readiness
// ---------------------------------------------------------------------------

describe("gateway not ready", () => {
  it("returns error when agentManagerRef.current is null", async () => {
    const handler = createHandler({}, { agentManagerRef: { current: null } });
    const result = await handler(["--target", "reviewer", "Hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("gateway not ready");
  });

  it("returns error when no context supplied", async () => {
    const handler = createHandler({});
    const result = await handler(["--target", "reviewer", "Hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("gateway not ready");
  });
});

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

describe("arg parsing", () => {
  let am: AgentManagerLike;
  let ss: ReturnType<typeof makeSessionStore>;
  let cfg: BeigeConfigLike;

  beforeEach(() => {
    am = makeAgentManager();
    ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    cfg = makeConfig();
  });

  it("returns usage when called with no args", async () => {
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, cfg)
    );
    const result = await handler([], undefined, { sessionKey: TOP_LEVEL_SESSION });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("returns error when --target is missing", async () => {
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, cfg)
    );
    const result = await handler(["Hello"], undefined, { sessionKey: TOP_LEVEL_SESSION });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--target");
  });

  it("accepts -t as short form of --target", async () => {
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, cfg)
    );
    const result = await handler(["-t", "reviewer", "Hello"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("joins positional args as the message", async () => {
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, cfg)
    );
    await handler(["--target", "reviewer", "please", "review", "this"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    const amCast = am as ReturnType<typeof makeAgentManager>;
    expect(amCast.calls[0].message).toBe("please review this");
  });

  it("returns error when message is empty", async () => {
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, cfg)
    );
    const result = await handler(["--target", "reviewer"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No message provided");
  });
});

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

describe("permission checks", () => {
  it("rejects when allowedTargets is not configured at all", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler({}, makeContext(am, ss, makeConfig()));
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No allowedTargets configured");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("rejects when caller has no entry in allowedTargets", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { reviewer: ["coder"] } }, // coder has no entry
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not permitted");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("rejects when target is not in caller's permitted list", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "assistant", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not permitted");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("allows call when target is in caller's permitted list", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows self-call (sub-agent) when own name is in permitted list", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["coder"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "coder", "Do this subtask"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Depth enforcement
// ---------------------------------------------------------------------------

describe("depth enforcement", () => {
  it("blocks call when caller is already at maxDepth", async () => {
    const am = makeAgentManager();
    // depth: 1 means this session was itself created by another agent
    const ss = makeSessionStore({
      "a2a:tui:human:default:coder:ts1": {
        agentName: "coder",
        metadata: { depth: 1 },
      },
    });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: "a2a:tui:human:default:coder:ts1" }
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("depth limit reached");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("allows call when caller depth is below maxDepth", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows two levels when maxDepth is 2", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "a2a:tui:human:default:coder:ts1": {
        agentName: "coder",
        metadata: { depth: 1 },
      },
    });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] }, maxDepth: 2 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: "a2a:tui:human:default:coder:ts1" }
    );
    expect(result.exitCode).toBe(0);
  });

  it("treats missing session entry as depth 0 (top-level session)", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({}); // no entry for caller
    const handler = createHandler(
      { allowedTargets: { unknown: ["reviewer"] }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    // sessionContext.channel is used as fallback agent name
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: "tui:unknown:default",
      channel: "unknown",
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks all calls when maxDepth is 0", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] }, maxDepth: 0 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("depth limit reached");
  });
});

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

describe("target validation", () => {
  it("rejects unknown target agent", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["ghost"] } },
      makeContext(am, ss, makeConfig()) // 'ghost' not in config
    );
    const result = await handler(["--target", "ghost", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown agent");
  });

  it("skips target validation when beigeConfig is not provided", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["ghost"] } },
      { agentManagerRef: { current: am }, sessionStore: ss } // no beigeConfig
    );
    const result = await handler(["--target", "ghost", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session creation and resumption
// ---------------------------------------------------------------------------

describe("session management", () => {
  it("creates a new session with correct metadata when no --session supplied", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    await handler(["--target", "reviewer", "Please review"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(ss.created).toHaveLength(1);
    expect(ss.created[0].agentName).toBe("reviewer");
    expect(ss.created[0].metadata?.depth).toBe(1);
    expect(ss.created[0].metadata?.parentSessionKey).toBe(TOP_LEVEL_SESSION);
    expect(ss.created[0].metadata?.invokedBy).toBe("coder");
  });

  it("creates independent sessions on separate calls without --session", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    await handler(["--target", "reviewer", "First task"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    await handler(["--target", "reviewer", "Second task"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(ss.created).toHaveLength(2);
    expect(ss.created[0].key).not.toBe(ss.created[1].key);
  });

  it("resumes existing session when --session is provided", async () => {
    const existingKey = "a2a:tui:coder:default:reviewer:existing";
    const am = makeAgentManager();
    const ss = makeSessionStore({
      [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY,
      [existingKey]: { agentName: "reviewer", metadata: { depth: 1 } },
    });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "--session", existingKey, "Follow-up question"],
      undefined,
      { sessionKey: TOP_LEVEL_SESSION }
    );
    expect(result.exitCode).toBe(0);
    expect(ss.created).toHaveLength(0); // no new session created
    const amCast = am as ReturnType<typeof makeAgentManager>;
    expect(amCast.calls[0].sessionKey).toBe(existingKey);
  });

  it("rejects --session when sessionStore is not available", async () => {
    const am = makeAgentManager();
    // Use channel as caller identity fallback since there's no sessionStore.
    // allowedTargets must permit "coder" (resolved via channel fallback) so the
    // permission check passes and we reach the session store guard.
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      { agentManagerRef: { current: am } } // no sessionStore
    );
    const result = await handler(
      ["--target", "reviewer", "--session", "some-key", "Hi"],
      undefined,
      { sessionKey: TOP_LEVEL_SESSION, channel: "coder" } // channel used as agent fallback
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("session store unavailable");
  });

  it("rejects --session key that does not exist", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "--session", "nonexistent-key", "Hi"],
      undefined,
      { sessionKey: TOP_LEVEL_SESSION }
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not found");
  });

  it("rejects --session key that belongs to a different agent", async () => {
    const wrongKey = "a2a:tui:coder:default:coder:ts1";
    const am = makeAgentManager();
    const ss = makeSessionStore({
      [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY,
      [wrongKey]: { agentName: "coder" }, // belongs to 'coder', not 'reviewer'
    });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "--session", wrongKey, "Hi"],
      undefined,
      { sessionKey: TOP_LEVEL_SESSION }
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("belongs to agent");
  });
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

describe("output format", () => {
  it("response starts with SESSION: line", async () => {
    const am = makeAgentManager("The code looks fine.");
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Review please"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.output.startsWith("SESSION: ")).toBe(true);
  });

  it("SESSION key is followed by --- separator then agent response", async () => {
    const am = makeAgentManager("LGTM!");
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Review"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    const lines = result.output.split("\n");
    expect(lines[0]).toMatch(/^SESSION: .+/);
    expect(lines[1]).toBe("---");
    expect(lines.slice(2).join("\n")).toBe("LGTM!");
  });

  it("SESSION key matches the key used to call agentManager.prompt", async () => {
    const am = makeAgentManager("Done.");
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Go"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    const sessionKeyInOutput = result.output.split("\n")[0].replace("SESSION: ", "");
    const amCast = am as ReturnType<typeof makeAgentManager>;
    expect(amCast.calls[0].sessionKey).toBe(sessionKeyInOutput);
  });
});

// ---------------------------------------------------------------------------
// Error handling — agentManager.prompt failure
// ---------------------------------------------------------------------------

describe("agentManager failures", () => {
  it("returns exitCode 1 when prompt throws", async () => {
    const failingAm: AgentManagerLike = {
      async prompt() {
        throw new Error("LLM unavailable");
      },
    };
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { allowedTargets: { coder: ["reviewer"] } },
      makeContext(failingAm, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("LLM unavailable");
  });
});
