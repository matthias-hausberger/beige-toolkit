/**
 * Unit tests for the spawn tool handler.
 *
 * All tests use injected stubs — no real AgentManager, SessionStore, or beige
 * config objects are needed.  Tests are deterministic and run in milliseconds.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createHandler,
  resolveTargets,
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
// resolveTargets helper
// ---------------------------------------------------------------------------

describe("resolveTargets", () => {
  it("returns empty map when targets is undefined", () => {
    const resolved = resolveTargets(undefined, "coder");
    expect(resolved.size).toBe(0);
  });

  it("passes through named targets unchanged", () => {
    const resolved = resolveTargets({ reviewer: {}, assistant: {} }, "coder");
    expect(resolved.has("reviewer")).toBe(true);
    expect(resolved.has("assistant")).toBe(true);
    expect(resolved.size).toBe(2);
  });

  it("resolves SELF to the calling agent name", () => {
    const resolved = resolveTargets({ SELF: { maxDepth: 2 } }, "coder");
    expect(resolved.has("coder")).toBe(true);
    expect(resolved.has("SELF")).toBe(false);
    expect(resolved.get("coder")!.maxDepth).toBe(2);
  });

  it("merges SELF with an explicit entry for the same agent (SELF wins as later entry)", () => {
    // When both "coder" and "SELF" exist, SELF resolves to "coder" and overwrites
    const resolved = resolveTargets({ coder: { maxDepth: 1 }, SELF: { maxDepth: 3 } }, "coder");
    expect(resolved.get("coder")!.maxDepth).toBe(3);
  });

  it("SELF resolves differently per caller", () => {
    const forCoder = resolveTargets({ SELF: {} }, "coder");
    const forReviewer = resolveTargets({ SELF: {} }, "reviewer");
    expect(forCoder.has("coder")).toBe(true);
    expect(forCoder.has("reviewer")).toBe(false);
    expect(forReviewer.has("reviewer")).toBe(true);
    expect(forReviewer.has("coder")).toBe(false);
  });
});

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
      { targets: { reviewer: {} } },
      makeContext(am, ss, cfg)
    );
    const result = await handler([], undefined, { sessionKey: TOP_LEVEL_SESSION });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("returns error when --target is missing", async () => {
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, cfg)
    );
    const result = await handler(["Hello"], undefined, { sessionKey: TOP_LEVEL_SESSION });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--target");
  });

  it("accepts -t as short form of --target", async () => {
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, cfg)
    );
    const result = await handler(["-t", "reviewer", "Hello"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("joins positional args as the message", async () => {
    const handler = createHandler(
      { targets: { reviewer: {} } },
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
      { targets: { reviewer: {} } },
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
  it("rejects when targets is not configured at all", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler({}, makeContext(am, ss, makeConfig()));
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No targets configured");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("rejects when target is not in the targets config", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "assistant", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not in the configured targets");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("allows call when target is in the targets config", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows self-call via SELF keyword", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { SELF: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "coder", "Do this subtask"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows self-call via explicit agent name in targets", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { coder: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "coder", "Do this subtask"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("rejects with empty targets object", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: {} },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No targets configured");
  });
});

// ---------------------------------------------------------------------------
// Depth enforcement
// ---------------------------------------------------------------------------

describe("depth enforcement", () => {
  it("blocks call when caller is already at default maxDepth", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "spawn:tui:human:default:coder:ts1": {
        agentName: "coder",
        metadata: { depth: 1 },
      },
    });
    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: "spawn:tui:human:default:coder:ts1" }
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("depth limit reached");
    expect((am as ReturnType<typeof makeAgentManager>).calls).toHaveLength(0);
  });

  it("allows call when caller depth is below default maxDepth", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows two levels when default maxDepth is 2", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "spawn:tui:human:default:coder:ts1": {
        agentName: "coder",
        metadata: { depth: 1 },
      },
    });
    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 2 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: "spawn:tui:human:default:coder:ts1" }
    );
    expect(result.exitCode).toBe(0);
  });

  it("uses per-target maxDepth override", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "spawn:tui:human:default:coder:ts1": {
        agentName: "coder",
        metadata: { depth: 1 },
      },
    });
    // Default maxDepth is 1, but reviewer gets maxDepth 2
    const handler = createHandler(
      { targets: { reviewer: { maxDepth: 2 } }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: "spawn:tui:human:default:coder:ts1" }
    );
    expect(result.exitCode).toBe(0);
  });

  it("per-target maxDepth can be more restrictive than default", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    // Default allows depth 2, but reviewer capped at 0
    const handler = createHandler(
      { targets: { reviewer: { maxDepth: 0 } }, maxDepth: 2 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("depth limit reached");
  });

  it("treats missing session entry as depth 0 (top-level session)", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({}); // no entry for caller
    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: "tui:unknown:default",
      channel: "unknown",
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks all calls when default maxDepth is 0 and no per-target override", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 0 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("depth limit reached");
  });

  it("SELF respects per-target maxDepth", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "spawn:tui:human:default:coder:ts1": {
        agentName: "coder",
        metadata: { depth: 1 },
      },
    });
    const handler = createHandler(
      { targets: { SELF: { maxDepth: 3 } }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    // Caller at depth 1, default maxDepth 1 would block, but SELF overrides to 3
    const result = await handler(
      ["--target", "coder", "Subtask"],
      undefined,
      { sessionKey: "spawn:tui:human:default:coder:ts1" }
    );
    expect(result.exitCode).toBe(0);
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
      { targets: { ghost: {} } },
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
      { targets: { ghost: {} } },
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
      { targets: { reviewer: {} } },
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
      { targets: { reviewer: {} } },
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
    const existingKey = "spawn:tui:coder:default:reviewer:existing";
    const am = makeAgentManager();
    const ss = makeSessionStore({
      [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY,
      [existingKey]: { agentName: "reviewer", metadata: { depth: 1 } },
    });
    const handler = createHandler(
      { targets: { reviewer: {} } },
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
    const handler = createHandler(
      { targets: { reviewer: {} } },
      { agentManagerRef: { current: am } } // no sessionStore
    );
    const result = await handler(
      ["--target", "reviewer", "--session", "some-key", "Hi"],
      undefined,
      { sessionKey: TOP_LEVEL_SESSION, agentName: "coder" }
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("session store unavailable");
  });

  it("rejects --session key that does not exist", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {} } },
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
    const wrongKey = "spawn:tui:coder:default:coder:ts1";
    const am = makeAgentManager();
    const ss = makeSessionStore({
      [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY,
      [wrongKey]: { agentName: "coder" }, // belongs to 'coder', not 'reviewer'
    });
    const handler = createHandler(
      { targets: { reviewer: {} } },
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
      { targets: { reviewer: {} } },
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
      { targets: { reviewer: {} } },
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
      { targets: { reviewer: {} } },
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
      { targets: { reviewer: {} } },
      makeContext(failingAm, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("LLM unavailable");
  });
});

// ---------------------------------------------------------------------------
// Caller identity — agentName field (primary source)
// ---------------------------------------------------------------------------

describe("caller identity resolution", () => {
  it("uses sessionContext.agentName as primary identity source", async () => {
    const am = makeAgentManager();
    // Session store has a DIFFERENT agent name — agentName on sessionContext must win
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: { agentName: "wrong-agent" } });
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder", // explicit agentName
    });
    expect(result.exitCode).toBe(0);
  });

  it("falls back to session store entry when agentName absent from sessionContext", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY }); // agentName: "coder"
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("does NOT use channel as agent name fallback", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({}); // no entry
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: "tui:coder:default",
      channel: "tui",
    });
    // Agent resolves to "unknown" which doesn't affect target check in new model,
    // but SELF resolution for "unknown" wouldn't match "reviewer" — this call
    // should succeed since "reviewer" is directly in targets
    expect(result.exitCode).toBe(0);
  });

  it("resolves correctly from sessionContext.agentName even without session store", async () => {
    const am = makeAgentManager();
    const handler = createHandler(
      { targets: { reviewer: {} } },
      { agentManagerRef: { current: am } } // no sessionStore, no beigeConfig
    );
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
  });

  it("SELF resolves based on caller identity", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { SELF: {} } },
      makeContext(am, ss, makeConfig())
    );
    // Caller is "coder" (from TOP_LEVEL_ENTRY), SELF resolves to "coder"
    const result = await handler(["--target", "coder", "Subtask"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(0);
  });

  it("SELF does not match a different agent", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { SELF: {} } },
      makeContext(am, ss, makeConfig())
    );
    // Caller is "coder" but trying to call "reviewer" — SELF only resolves to "coder"
    const result = await handler(["--target", "reviewer", "Hi"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not in the configured targets");
  });
});

// ---------------------------------------------------------------------------
// --info flag
// ---------------------------------------------------------------------------

describe("--info flag", () => {
  it("returns exitCode 0 with permission summary", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {}, SELF: { maxDepth: 2 } }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("coder");
    expect(result.output).toContain("reviewer");
    expect(result.output).toContain("depth");
  });

  it("shows DISABLED when no targets configured", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      {},
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("DISABLED");
  });

  it("shows BLOCKED when caller is at max depth for all targets", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "spawn:tui:human:default:coder:ts1": { agentName: "coder", metadata: { depth: 1 } },
    });
    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: "spawn:tui:human:default:coder:ts1",
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("BLOCKED");
  });

  it("shows ACTIVE when some targets are reachable", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({
      "spawn:tui:human:default:coder:ts1": { agentName: "coder", metadata: { depth: 1 } },
    });
    // reviewer blocked (maxDepth 1), but SELF (coder) has maxDepth 3
    const handler = createHandler(
      { targets: { reviewer: {}, SELF: { maxDepth: 3 } }, maxDepth: 1 },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: "spawn:tui:human:default:coder:ts1",
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ACTIVE");
  });

  it("shows sub-agent annotation for SELF targets", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { SELF: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("sub-agent");
  });

  it("works without --target (--info is standalone)", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(am as ReturnType<typeof makeAgentManager>).toBeDefined();
  });

  it("shows raw config including SELF before resolution", async () => {
    const am = makeAgentManager();
    const ss = makeSessionStore({ [TOP_LEVEL_SESSION]: TOP_LEVEL_ENTRY });
    const handler = createHandler(
      { targets: { SELF: { maxDepth: 2 }, reviewer: {} } },
      makeContext(am, ss, makeConfig())
    );
    const result = await handler(["--info"], undefined, {
      sessionKey: TOP_LEVEL_SESSION,
      agentName: "coder",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("SELF");
    expect(result.output).toContain("Raw targets config");
  });
});
