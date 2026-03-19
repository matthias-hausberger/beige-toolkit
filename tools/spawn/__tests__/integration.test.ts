/**
 * Integration tests for the spawn tool.
 *
 * Covers manifest validity and end-to-end handler flows that exercise multiple
 * components together — e.g. session metadata being written then read back on
 * a follow-up call.
 */

import { describe, it, expect } from "vitest";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import { assertValidToolManifest } from "../../../test-utils/assertions.js";
import {
  createHandler,
  type AgentManagerLike,
  type SessionStoreLike,
  type SessionEntryLike,
  type BeigeConfigLike,
} from "../index.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("tool manifest", () => {
  const manifest = loadToolManifest("tools/spawn");

  it("is valid", () => {
    assertValidToolManifest(manifest);
  });

  it("has name spawn", () => {
    expect(manifest.name).toBe("spawn");
  });

  it("target is gateway", () => {
    expect(manifest.target).toBe("gateway");
  });

  it("lists at least one command example", () => {
    expect(manifest.commands?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple in-memory session store that wires createSession → getEntry. */
function makeRealishSessionStore(): SessionStoreLike & {
  created: Array<{ key: string; agentName: string; metadata?: Record<string, unknown> }>;
} {
  const map: Record<string, SessionEntryLike> = {};
  const created: Array<{ key: string; agentName: string; metadata?: Record<string, unknown> }> = [];
  return {
    created,
    getEntry(key) { return map[key]; },
    createSession(key, agentName, metadata) {
      map[key] = { agentName, metadata };
      created.push({ key, agentName, metadata });
      return `/fake/${agentName}/${key}.jsonl`;
    },
  };
}

function makeAgentManager(response = "response"): AgentManagerLike & {
  calls: Array<{ sessionKey: string; agentName: string; message: string }>;
} {
  const calls: Array<{ sessionKey: string; agentName: string; message: string }> = [];
  return {
    calls,
    async prompt(sessionKey, agentName, message) {
      calls.push({ sessionKey, agentName, message });
      return response;
    },
  };
}

const BEIGE_CONFIG: BeigeConfigLike = { agents: { coder: {}, reviewer: {}, assistant: {} } };
const CALLER_KEY = "tui:coder:default";

// ---------------------------------------------------------------------------
// Multi-turn conversation flow
// ---------------------------------------------------------------------------

describe("multi-turn conversation", () => {
  it("second call with --session reuses the same session key and skips creation", async () => {
    const am = makeAgentManager();
    const ss = makeRealishSessionStore();

    // Seed the calling session so agent name can be resolved
    ss.createSession(CALLER_KEY, "coder");

    const handler = createHandler(
      { targets: { reviewer: {} } },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    // First call — creates a new session
    const first = await handler(["--target", "reviewer", "Please review /workspace/src"], undefined, {
      sessionKey: CALLER_KEY,
    });
    expect(first.exitCode).toBe(0);

    const sessionKey = first.output.split("\n")[0].replace("SESSION: ", "");

    // Second call — resumes the same session
    const second = await handler(
      ["--target", "reviewer", "--session", sessionKey, "Also check the tests"],
      undefined,
      { sessionKey: CALLER_KEY }
    );
    expect(second.exitCode).toBe(0);

    // Only one session was ever created (for reviewer; the CALLER_KEY seed doesn't count)
    const userCreated = ss.created.filter((c) => c.agentName === "reviewer");
    expect(userCreated).toHaveLength(1);

    // Both prompt calls used the same session key
    expect(am.calls[0].sessionKey).toBe(sessionKey);
    expect(am.calls[1].sessionKey).toBe(sessionKey);
  });

  it("second call without --session creates a new independent session", async () => {
    const am = makeAgentManager();
    const ss = makeRealishSessionStore();
    ss.createSession(CALLER_KEY, "coder");

    const handler = createHandler(
      { targets: { reviewer: {} } },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    const first = await handler(["--target", "reviewer", "Task one"], undefined, {
      sessionKey: CALLER_KEY,
    });
    const second = await handler(["--target", "reviewer", "Task two"], undefined, {
      sessionKey: CALLER_KEY,
    });

    const key1 = first.output.split("\n")[0].replace("SESSION: ", "");
    const key2 = second.output.split("\n")[0].replace("SESSION: ", "");

    expect(key1).not.toBe(key2);

    const reviewerSessions = ss.created.filter((c) => c.agentName === "reviewer");
    expect(reviewerSessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Depth metadata propagation
// ---------------------------------------------------------------------------

describe("depth metadata", () => {
  it("writes depth=1 on a child session created from a top-level session", async () => {
    const am = makeAgentManager();
    const ss = makeRealishSessionStore();
    ss.createSession(CALLER_KEY, "coder"); // no metadata → depth 0

    const handler = createHandler(
      { targets: { reviewer: {} } },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    await handler(["--target", "reviewer", "Go"], undefined, { sessionKey: CALLER_KEY });

    const reviewerSession = ss.created.find((c) => c.agentName === "reviewer")!;
    expect(reviewerSession.metadata?.depth).toBe(1);
    expect(reviewerSession.metadata?.parentSessionKey).toBe(CALLER_KEY);
    expect(reviewerSession.metadata?.invokedBy).toBe("coder");
  });

  it("sub-agent at depth 1 is blocked from calling further (default maxDepth=1)", async () => {
    const am = makeAgentManager();
    const ss = makeRealishSessionStore();

    // Seed a depth-1 session (was itself created by another agent)
    const depth1Key = "spawn:tui:human:default:coder:abc";
    ss.createSession(depth1Key, "coder", { depth: 1, parentSessionKey: "tui:human:default", invokedBy: "human" });

    const handler = createHandler(
      { targets: { reviewer: {} }, maxDepth: 1 },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: depth1Key }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("depth limit reached");
    expect(am.calls).toHaveLength(0);
  });

  it("sub-agent at depth 1 can call further when target maxDepth=2", async () => {
    const am = makeAgentManager();
    const ss = makeRealishSessionStore();

    const depth1Key = "spawn:tui:human:default:coder:abc";
    ss.createSession(depth1Key, "coder", { depth: 1, parentSessionKey: "tui:human:default", invokedBy: "human" });

    const handler = createHandler(
      { targets: { reviewer: { maxDepth: 2 } } },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    const result = await handler(
      ["--target", "reviewer", "Hi"],
      undefined,
      { sessionKey: depth1Key }
    );

    expect(result.exitCode).toBe(0);
    // The grandchild session should have depth 2
    const grandchild = ss.created.find((c) => c.agentName === "reviewer")!;
    expect(grandchild.metadata?.depth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Parallel conversations
// ---------------------------------------------------------------------------

describe("parallel conversations", () => {
  it("two independent reviewer sessions can be maintained simultaneously", async () => {
    const responses = ["Review A done.", "Review B done."];
    let callCount = 0;
    const am: AgentManagerLike = {
      async prompt(sessionKey, agentName, message) {
        return responses[callCount++] ?? "ok";
      },
    };
    const ss = makeRealishSessionStore();
    ss.createSession(CALLER_KEY, "coder");

    const handler = createHandler(
      { targets: { reviewer: {} } },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    const resultA = await handler(["--target", "reviewer", "Review feature A"], undefined, {
      sessionKey: CALLER_KEY,
    });
    const resultB = await handler(["--target", "reviewer", "Review feature B"], undefined, {
      sessionKey: CALLER_KEY,
    });

    const keyA = resultA.output.split("\n")[0].replace("SESSION: ", "");
    const keyB = resultB.output.split("\n")[0].replace("SESSION: ", "");

    expect(keyA).not.toBe(keyB);
    expect(resultA.output).toContain("Review A done.");
    expect(resultB.output).toContain("Review B done.");

    // Follow up on A specifically — should succeed and reuse keyA, not create a new session
    const followUpA = await handler(
      ["--target", "reviewer", "--session", keyA, "What about the edge cases?"],
      undefined,
      { sessionKey: CALLER_KEY }
    );
    expect(followUpA.exitCode).toBe(0);
    const followUpKey = followUpA.output.split("\n")[0].replace("SESSION: ", "");
    expect(followUpKey).toBe(keyA);

    // Session store should still have only 2 reviewer sessions (no new one created for follow-up)
    const reviewerSessions = ss.created.filter((c) => c.agentName === "reviewer");
    expect(reviewerSessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SELF keyword integration
// ---------------------------------------------------------------------------

describe("SELF keyword", () => {
  it("allows sub-agent calls via SELF and tracks depth correctly", async () => {
    const am = makeAgentManager("Subtask complete.");
    const ss = makeRealishSessionStore();
    ss.createSession(CALLER_KEY, "coder");

    const handler = createHandler(
      { targets: { SELF: { maxDepth: 2 } } },
      { agentManagerRef: { current: am }, sessionStore: ss, beigeConfig: BEIGE_CONFIG }
    );

    const result = await handler(["--target", "coder", "Do subtask"], undefined, {
      sessionKey: CALLER_KEY,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Subtask complete.");

    // Sub-session should have depth 1 and invokedBy "coder"
    const childSession = ss.created.find((c) => c.agentName === "coder" && c.key !== CALLER_KEY)!;
    expect(childSession.metadata?.depth).toBe(1);
    expect(childSession.metadata?.invokedBy).toBe("coder");
  });
});
