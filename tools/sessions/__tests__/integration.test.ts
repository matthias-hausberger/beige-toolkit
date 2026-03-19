/**
 * Integration tests for the sessions tool.
 *
 * Covers manifest validity and end-to-end handler flows using real temp files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import { assertValidToolManifest } from "../../../test-utils/assertions.js";
import { createHandler, type SessionStoreLike, type SessionEntryLike, type SessionInfoLike } from "../index.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("tool manifest", () => {
  const manifest = loadToolManifest("tools/sessions");

  it("is valid", () => {
    assertValidToolManifest(manifest);
  });

  it("has name sessions", () => {
    expect(manifest.name).toBe("sessions");
  });

  it("target is gateway", () => {
    expect(manifest.target).toBe("gateway");
  });

  it("lists at least one command example", () => {
    expect(manifest.commands?.length).toBeGreaterThan(0);
  });

  it("commands include list, get, and grep", () => {
    const cmds = manifest.commands?.join(" ") ?? "";
    expect(cmds).toContain("list");
    expect(cmds).toContain("get");
    expect(cmds).toContain("grep");
  });
});

// ---------------------------------------------------------------------------
// Helpers — real temp session files
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beige-sessions-integration-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true }); } catch {}
  }
  tmpDirs = [];
});

function writeSessionFile(
  dir: string,
  messages: Array<{ role: string; text: string }>
): string {
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: "test", timestamp: new Date().toISOString(), cwd: "/workspace" }),
    JSON.stringify({ type: "model_change", id: "mc1", parentId: null, timestamp: new Date().toISOString(), provider: "anthropic", modelId: "claude-sonnet-4-6" }),
  ];
  for (const [i, m] of messages.entries()) {
    lines.push(JSON.stringify({
      type: "message",
      id: `msg-${i}`,
      parentId: i === 0 ? "mc1" : `msg-${i - 1}`,
      timestamp: new Date().toISOString(),
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

function makeStore(
  entries: Record<string, SessionEntryLike>,
  sessions: Record<string, SessionInfoLike[]>
): SessionStoreLike {
  return {
    getEntry(key) { return entries[key]; },
    listSessions(agentName) { return sessions[agentName] ?? []; },
  };
}

const AGENT = "coder";
const SESSION_CTX = { sessionKey: "tui:coder:default", agentName: AGENT };

// ---------------------------------------------------------------------------
// Full list → get → grep round-trip
// ---------------------------------------------------------------------------

describe("list → get → grep round-trip", () => {
  it("lists a session, retrieves it, then greps a term from it", async () => {
    const dir = makeTempDir();
    const file = writeSessionFile(dir, [
      { role: "user", text: "Please refactor the authentication module" },
      { role: "assistant", text: "I'll start by reviewing the current authentication code." },
      { role: "user", text: "Also add unit tests for the auth functions" },
      { role: "assistant", text: "Sure, I'll write tests for the authentication module." },
    ]);

    const entry: SessionEntryLike = { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() };
    const info: SessionInfoLike = { sessionFile: file, sessionId: "s1", agentName: "coder", firstMessage: "Please refactor", createdAt: new Date().toISOString() };
    const ss = makeStore({ "tui:coder:default": entry }, { coder: [info] });
    const handler = createHandler({}, { sessionStore: ss });

    // list
    const listResult = await handler(["list"], undefined, SESSION_CTX);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.output).toContain("1 session");

    // get
    const getResult = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);
    expect(getResult.exitCode).toBe(0);
    expect(getResult.output).toContain("Messages: 4");
    expect(getResult.output).toContain("authentication module");

    // grep
    const grepResult = await handler(["grep", "authentication"], undefined, SESSION_CTX);
    expect(grepResult.exitCode).toBe(0);
    expect(grepResult.output).toContain("matches");
    expect(grepResult.output).toContain("authentication");
  });
});

// ---------------------------------------------------------------------------
// Ownership enforcement across operations
// ---------------------------------------------------------------------------

describe("ownership enforcement", () => {
  it("get rejects cross-agent access consistently", async () => {
    const dir = makeTempDir();
    const file = writeSessionFile(dir, [{ role: "user", text: "secret" }]);
    const ss = makeStore(
      { "tui:reviewer:default": { agentName: "reviewer", sessionFile: file, createdAt: new Date().toISOString() } },
      {}
    );
    const handler = createHandler({}, { sessionStore: ss });

    // coder trying to read reviewer's session
    const result = await handler(["get", "tui:reviewer:default"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).not.toContain("secret");
  });

  it("grep rejects cross-agent --session access consistently", async () => {
    const dir = makeTempDir();
    const file = writeSessionFile(dir, [{ role: "user", text: "secret pattern" }]);
    const ss = makeStore(
      { "tui:reviewer:default": { agentName: "reviewer", sessionFile: file, createdAt: new Date().toISOString() } },
      {}
    );
    const handler = createHandler({}, { sessionStore: ss });

    const result = await handler(
      ["grep", "secret", "--session", "tui:reviewer:default"],
      undefined,
      SESSION_CTX
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("list only returns calling agent's sessions", async () => {
    const dir = makeTempDir();
    const coderFile = writeSessionFile(dir, [{ role: "user", text: "coder message" }]);
    const reviewerFile = writeSessionFile(dir, [{ role: "user", text: "reviewer message" }]);

    const ss = makeStore(
      {
        "tui:coder:default": { agentName: "coder", sessionFile: coderFile, createdAt: new Date().toISOString() },
        "tui:reviewer:default": { agentName: "reviewer", sessionFile: reviewerFile, createdAt: new Date().toISOString() },
      },
      {
        // listSessions is scoped by agentName — only coder sessions returned
        coder: [{ sessionFile: coderFile, sessionId: "c1", agentName: "coder", firstMessage: "coder message", createdAt: new Date().toISOString() }],
      }
    );
    const handler = createHandler({}, { sessionStore: ss });

    const result = await handler(["list"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("1 session");
    expect(result.output).not.toContain("reviewer");
  });
});

// ---------------------------------------------------------------------------
// JSON output format
// ---------------------------------------------------------------------------

describe("json output", () => {
  it("list json contains all expected fields", async () => {
    const dir = makeTempDir();
    const file = writeSessionFile(dir, [{ role: "user", text: "test" }]);
    const ss = makeStore(
      {},
      { coder: [{ sessionFile: file, sessionId: "s1", agentName: "coder", firstMessage: "test", createdAt: new Date().toISOString() }] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["list", "--format", "json"], undefined, SESSION_CTX);
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveProperty("agentName");
    expect(parsed).toHaveProperty("sessions");
    expect(parsed.sessions[0]).toHaveProperty("sessionFile");
    expect(parsed.sessions[0]).toHaveProperty("createdAt");
  });

  it("get json contains messages array with role and text", async () => {
    const dir = makeTempDir();
    const file = writeSessionFile(dir, [
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ]);
    const ss = makeStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      {}
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default", "--format", "json"], undefined, SESSION_CTX);
    const parsed = JSON.parse(result.output);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({ role: "user", text: "question" });
    expect(parsed.messages[1]).toMatchObject({ role: "assistant", text: "answer" });
  });

  it("grep json contains pattern and matches array", async () => {
    const dir = makeTempDir();
    const file = writeSessionFile(dir, [{ role: "user", text: "find this pattern" }]);
    const ss = makeStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      { coder: [{ sessionFile: file, sessionId: "s1", agentName: "coder", firstMessage: "find", createdAt: new Date().toISOString() }] }
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["grep", "find this", "--format", "json"], undefined, SESSION_CTX);
    const parsed = JSON.parse(result.output);
    expect(parsed.pattern).toBe("find this");
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]).toHaveProperty("snippet");
    expect(parsed.matches[0]).toHaveProperty("messageIndex");
    expect(parsed.matches[0]).toHaveProperty("role");
  });
});

// ---------------------------------------------------------------------------
// Tool call entries in session files
// ---------------------------------------------------------------------------

describe("tool call parsing", () => {
  it("represents tool calls as [tool: name] in text output", async () => {
    const dir = makeTempDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", version: 3, id: "t", timestamp: new Date().toISOString(), cwd: "/" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", id: "call1", name: "exec", arguments: { command: "ls" } },
          ],
          timestamp: Date.now(),
        },
      }),
    ].join("\n"));

    const ss = makeStore(
      { "tui:coder:default": { agentName: "coder", sessionFile: file, createdAt: new Date().toISOString() } },
      {}
    );
    const handler = createHandler({}, { sessionStore: ss });
    const result = await handler(["get", "tui:coder:default"], undefined, SESSION_CTX);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Let me check that.");
    expect(result.output).toContain("[tool: exec]");
  });
});
