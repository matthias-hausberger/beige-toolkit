/**
 * Unit tests for the sessions tool handler.
 *
 * All tests use injected stubs — no real filesystem, no real session store.
 * Tests are fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, type SessionStoreLike, type SessionEntryLike, type SessionInfoLike } from "../index.js";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makeSessionStore(
  entries: Record<string, SessionEntryLike> = {},
  sessions: Record<string, SessionInfoLike[]> = {}
): SessionStoreLike {
  return {
    getEntry(key) {
      return entries[key];
    },
    listSessions(agentName) {
      return sessions[agentName] ?? [];
    },
  };
}

const AGENT = "coder";
const SESSION_CTX = { sessionKey: "tui:coder:default", agentName: AGENT };

// A fake session file that doesn't exist on disk — used for tests that
// don't need real file content (list, ownership errors).
const FAKE_FILE = "/nonexistent/sessions/coder/fake.jsonl";

function makeEntry(agentName: string, file = FAKE_FILE): SessionEntryLike {
  return { agentName, sessionFile: file, createdAt: "2026-03-17T20:00:00.000Z" };
}

function makeInfo(sessionId: string, agentName: string, file = FAKE_FILE): SessionInfoLike {
  return {
    sessionFile: file,
    sessionId,
    agentName,
    firstMessage: "Hello",
    createdAt: "2026-03-17T20:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// No session store
// ---------------------------------------------------------------------------

describe("no session store", () => {
  it("returns error when sessionStore is not injected", async () => {
    const handler = createHandler({}, {});
    const result = await handler(["list"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("session store unavailable");
  });
});

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

describe("agent identity", () => {
  it("resolves from sessionContext.agentName", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list"], undefined, { agentName: "coder" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("coder");
  });

  it("falls back to session store entry when agentName absent", async () => {
    const ss = makeSessionStore(
      { "tui:coder:default": makeEntry("coder") },
      { coder: [] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list"], undefined, { sessionKey: "tui:coder:default" });
    expect(result.exitCode).toBe(0);
  });

  it("returns error when agent is unknown", async () => {
    const ss = makeSessionStore({}, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list"], undefined, {}); // no agentName, no sessionKey
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("agent identity unknown");
  });
});

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

describe("arg parsing", () => {
  it("returns usage when no args", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler([], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("returns error for unknown subcommand", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["bogus"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unknown subcommand");
    expect(result.output).toContain("bogus");
  });

  it("returns error when subcommand missing (flag only)", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["--format", "json"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("subcommand required");
  });
});

// ---------------------------------------------------------------------------
// sessions list
// ---------------------------------------------------------------------------

describe("sessions list", () => {
  it("returns no-sessions message when store is empty", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No sessions found");
  });

  it("lists sessions with count header", async () => {
    const ss = makeSessionStore(
      {},
      { coder: [makeInfo("s1", "coder"), makeInfo("s2", "coder")] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("2 sessions");
    expect(result.output).toContain("coder");
  });

  it("marks first session as most recent", async () => {
    const ss = makeSessionStore(
      {},
      { coder: [makeInfo("s1", "coder"), makeInfo("s2", "coder")] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list"], undefined, SESSION_CTX);
    expect(result.output).toContain("most recent");
  });

  it("includes active session label with --include-active when not already in list", async () => {
    const activeFile = "/sessions/coder/active.jsonl";
    const ss = makeSessionStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: activeFile, createdAt: "2026-03-17T22:00:00.000Z" } },
      { coder: [makeInfo("s1", "coder")] } // active file not in this list
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list", "--include-active"], undefined, SESSION_CTX);
    expect(result.output).toContain("(active)");
  });

  it("does not duplicate active session if already in session list", async () => {
    const file = FAKE_FILE;
    const ss = makeSessionStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: "2026-03-17T22:00:00.000Z" } },
      { coder: [makeInfo("s1", "coder", file)] } // same file
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list", "--include-active"], undefined, SESSION_CTX);
    const activeCount = (result.output.match(/\(active\)/g) ?? []).length;
    expect(activeCount).toBeLessThanOrEqual(1);
  });

  it("returns json with --format json", async () => {
    const ss = makeSessionStore(
      {},
      { coder: [makeInfo("s1", "coder")] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list", "--format", "json"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.agentName).toBe("coder");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions).toHaveLength(1);
  });

  it("returns empty json sessions array when no sessions", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list", "--format", "json"], undefined, SESSION_CTX);
    const parsed = JSON.parse(result.output);
    expect(parsed.sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sessions get
// ---------------------------------------------------------------------------

describe("sessions get", () => {
  it("returns error when no key provided", async () => {
    const ss = makeSessionStore({}, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("session key required");
  });

  it("returns error when session not found in store", async () => {
    const ss = makeSessionStore({}, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "nonexistent-key"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not found");
  });

  it("returns permission error when session belongs to another agent", async () => {
    const ss = makeSessionStore({
      "tui:reviewer:default": makeEntry("reviewer"),
    }, {});
    const handler = createHandler({}, { sessionStore: ss });
    // coder trying to read reviewer's session
    const result = await handler(["get", "tui:reviewer:default"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("reviewer");
  });

  it("returns error when session file does not exist on disk", async () => {
    const ss = makeSessionStore({
      "tui:coder:default": makeEntry("coder", "/nonexistent/path.jsonl"),
    }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no longer exists");
  });
});

// ---------------------------------------------------------------------------
// sessions get — with real session files
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function makeTempSessionFile(messages: Array<{ role: string; text: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "beige-sessions-test-"));
  const file = join(dir, "test-session.jsonl");

  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: "test", timestamp: "2026-03-17T20:00:00.000Z", cwd: "/workspace" }),
  ];

  for (const [i, m] of messages.entries()) {
    lines.push(JSON.stringify({
      type: "message",
      id: `msg-${i}`,
      parentId: i === 0 ? null : `msg-${i - 1}`,
      timestamp: `2026-03-17T20:0${i}:00.000Z`,
      message: {
        role: m.role,
        content: [{ type: "text", text: m.text }],
        timestamp: Date.now(),
      },
    }));
  }

  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("sessions get — real file content", () => {
  let tmpFile: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beige-sessions-test-"));
    tmpFile = join(tmpDir, "session.jsonl");
  });

  it("formats messages with role and index", async () => {
    const file = makeTempSessionFile([
      { role: "user", text: "Hello there" },
      { role: "assistant", text: "Hi! How can I help?" },
    ]);

    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[1] user");
    expect(result.output).toContain("Hello there");
    expect(result.output).toContain("[2] assistant");
    expect(result.output).toContain("Hi! How can I help?");
  });

  it("shows session header with message count", async () => {
    const file = makeTempSessionFile([
      { role: "user", text: "msg1" },
      { role: "assistant", text: "msg2" },
      { role: "user", text: "msg3" },
    ]);
    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);

    expect(result.output).toContain("Messages: 3");
  });

  it("truncates long sessions and shows omission notice", async () => {
    const msgs = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i + 1}`,
    }));
    const file = makeTempSessionFile(msgs);
    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);

    expect(result.output).toContain("omitted");
    // Should show first 5
    expect(result.output).toContain("Message 1");
    expect(result.output).toContain("Message 5");
    // Should show last 5
    expect(result.output).toContain("Message 56");
    expect(result.output).toContain("Message 60");
    // Should NOT show middle messages
    expect(result.output).not.toContain("Message 30");
  });

  it("--all disables truncation", async () => {
    const msgs = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i + 1}`,
    }));
    const file = makeTempSessionFile(msgs);
    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default", "--all"], undefined, SESSION_CTX);

    expect(result.output).not.toContain("omitted");
    expect(result.output).toContain("Message 30");
  });

  it("returns json with --format json", async () => {
    const file = makeTempSessionFile([
      { role: "user", text: "test" },
    ]);
    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default", "--format", "json"], undefined, SESSION_CTX);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.key).toBe("tui:coder:default");
    expect(parsed.agentName).toBe("coder");
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].text).toBe("test");
  });

  it("handles empty session file gracefully", async () => {
    writeFileSync(tmpFile, "");
    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: tmpFile, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("no messages");
  });

  it("skips malformed jsonl lines without crashing", async () => {
    writeFileSync(tmpFile, [
      JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-03-17T20:00:00.000Z", cwd: "/" }),
      "NOT VALID JSON",
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-03-17T20:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "good message" }], timestamp: Date.now() } }),
    ].join("\n"));
    const ss = makeSessionStore({ "tui:coder:default": { agentName: "coder", sessionFile: tmpFile, createdAt: new Date().toISOString() } }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("good message");
  });
});

// ---------------------------------------------------------------------------
// sessions grep
// ---------------------------------------------------------------------------

describe("sessions grep", () => {
  it("returns error when no pattern provided", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("pattern required");
  });

  it("returns no-matches message when nothing found", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "xyzzy-no-match"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No matches");
  });

  it("returns permission error when --session belongs to another agent", async () => {
    const ss = makeSessionStore({
      "tui:reviewer:default": makeEntry("reviewer"),
    }, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(
      ["grep", "pattern", "--session", "tui:reviewer:default"],
      undefined,
      SESSION_CTX
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("returns error when --session key not found", async () => {
    const ss = makeSessionStore({}, {});
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "pattern", "--session", "nonexistent"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not found");
  });

  it("returns error for invalid regex", async () => {
    const ss = makeSessionStore({}, { coder: [] });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "/[invalid/"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid regex");
  });
});

describe("sessions grep — real file content", () => {
  it("finds substring matches across sessions", async () => {
    const file1 = makeTempSessionFile([
      { role: "user", text: "Can you refactor the auth module?" },
      { role: "assistant", text: "Sure, I will start with auth module cleanup." },
    ]);
    const file2 = makeTempSessionFile([
      { role: "user", text: "What is the weather today?" },
      { role: "assistant", text: "I don't have weather access." },
    ]);

    const ss = makeSessionStore(
      {
        "tui:coder:s1": { agentName: "coder", sessionFile: file1, createdAt: "2026-03-17T20:00:00.000Z" },
        "tui:coder:s2": { agentName: "coder", sessionFile: file2, createdAt: "2026-03-17T21:00:00.000Z" },
      },
      {
        coder: [
          { sessionFile: file1, sessionId: "s1", agentName: "coder", firstMessage: "Can you refactor", createdAt: "2026-03-17T20:00:00.000Z" },
          { sessionFile: file2, sessionId: "s2", agentName: "coder", firstMessage: "What is the weather", createdAt: "2026-03-17T21:00:00.000Z" },
        ],
      }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "auth module"], undefined, SESSION_CTX);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("2 matches");
    expect(result.output).toContain("auth module");
  });

  it("finds regex matches", async () => {
    const file = makeTempSessionFile([
      { role: "user", text: "Please fix the TypeError in line 42" },
      { role: "assistant", text: "I see the issue, it is a TypeError" },
    ]);
    const ss = makeSessionStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      { coder: [{ sessionFile: file, sessionId: "s1", agentName: "coder", firstMessage: "fix", createdAt: new Date().toISOString() }] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "/TypeError/"], undefined, SESSION_CTX);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("2 matches");
  });

  it("respects --max-matches limit", async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `matching text ${i}`,
    }));
    const file = makeTempSessionFile(msgs);
    const ss = makeSessionStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      { coder: [{ sessionFile: file, sessionId: "s1", agentName: "coder", firstMessage: "match", createdAt: new Date().toISOString() }] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "matching text", "--max-matches", "5"], undefined, SESSION_CTX);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("5");
    expect(result.output).toContain("limit");
  });

  it("respects --max-sessions limit and shows note when truncated", async () => {
    // Create 3 sessions but limit to 2
    const makeSession = (text: string) => makeTempSessionFile([{ role: "user", text }]);
    const f1 = makeSession("match here");
    const f2 = makeSession("match here too");
    const f3 = makeSession("match here also");

    const sessions: SessionInfoLike[] = [
      { sessionFile: f1, sessionId: "s1", agentName: "coder", firstMessage: "m", createdAt: "2026-03-17T22:00:00.000Z" },
      { sessionFile: f2, sessionId: "s2", agentName: "coder", firstMessage: "m", createdAt: "2026-03-17T21:00:00.000Z" },
      { sessionFile: f3, sessionId: "s3", agentName: "coder", firstMessage: "m", createdAt: "2026-03-17T20:00:00.000Z" },
    ];
    const ss = makeSessionStore({}, { coder: sessions });
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "match here", "--max-sessions", "2"], undefined, SESSION_CTX);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("searched 2 of 3 sessions");
  });

  it("--session scopes to single session and bypasses max-sessions", async () => {
    const file = makeTempSessionFile([
      { role: "user", text: "scoped search target" },
    ]);
    const ss = makeSessionStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      { coder: [] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(
      ["grep", "scoped search", "--session", "tui:coder:default", "--max-sessions", "1"],
      undefined,
      SESSION_CTX
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("1 match");
    // No session-limit note since --session was used
    expect(result.output).not.toContain("searched");
  });

  it("returns json with --format json", async () => {
    const file = makeTempSessionFile([
      { role: "user", text: "json search target" },
    ]);
    const ss = makeSessionStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      { coder: [{ sessionFile: file, sessionId: "s1", agentName: "coder", firstMessage: "json", createdAt: new Date().toISOString() }] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(
      ["grep", "json search", "--format", "json"],
      undefined,
      SESSION_CTX
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.pattern).toBe("json search");
    expect(parsed.agentName).toBe("coder");
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(parsed.matches[0].role).toBe("user");
    expect(parsed.matches[0].sessionKey).toBeDefined();
  });
});
