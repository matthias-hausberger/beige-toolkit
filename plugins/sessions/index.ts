/**
 * sessions tool
 *
 * Lets a beige agent browse and search its own conversation history.
 *
 * ── Subcommands ─────────────────────────────────────────────────────────────
 *
 *   list                         List sessions for this agent (newest first).
 *   get <key>                    Print the full message history of a session.
 *   grep <pattern>               Search message content across sessions.
 *
 * ── Security model ──────────────────────────────────────────────────────────
 *
 * Every operation is scoped to the calling agent.  The agent name is resolved
 * from sessionContext.agentName (injected by beige as BEIGE_AGENT_NAME) with a
 * fallback to the session store entry.  If the agent name cannot be determined
 * the tool returns an error — it never falls back to reading all sessions.
 *
 * Before reading any session file, ownership is verified:
 *   sessionStore.getEntry(key).agentName === callerAgent
 * A mismatch returns a permission error regardless of what the caller passes.
 *
 * ── Session file format ──────────────────────────────────────────────────────
 *
 * Sessions are pi JSONL files.  Each line is a JSON object with a `type` field.
 * This tool reads lines where type === "message" and extracts:
 *   - role:     "user" | "assistant" | "tool"  (toolResult → "tool")
 *   - text:     joined text content; tool calls summarised as "[tool: name]"
 *   - timestamp
 *
 * All other line types (model_change, thinking_level_change, compaction, …)
 * are silently skipped.  Malformed lines are also skipped.
 *
 * ── Dependency injection ────────────────────────────────────────────────────
 *
 * createHandler accepts an optional context argument for testing:
 *
 *   { sessionStore? }
 *
 * In production beige injects the real sessionStore via ToolHandlerContext.
 */

import { readFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Types — self-contained, no beige source imports.
// ---------------------------------------------------------------------------

/** Subset of BeigeSessionStore used by this tool. */
export interface SessionStoreLike {
  getEntry(key: string): SessionEntryLike | undefined;
  listSessions(agentName: string, opts?: { includeToolSessions?: boolean }): SessionInfoLike[];
}

export interface SessionEntryLike {
  agentName: string;
  sessionFile: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SessionInfoLike {
  sessionFile: string;
  sessionId: string;
  agentName: string;
  firstMessage: string;
  createdAt: string;
}

/** Context injected by the gateway (or by tests). */
export interface SessionsContext {
  sessionStore?: SessionStoreLike;
}

/** Extended SessionContext — includes agentName injected by beige. */
interface IncomingSessionContext {
  sessionKey?: string;
  channel?: string;
  agentName?: string;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: IncomingSessionContext
) => Promise<{ output: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Parsed session message (internal)
// ---------------------------------------------------------------------------

interface ParsedMessage {
  index: number;
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Session file parser
// ---------------------------------------------------------------------------

function parseSessionFile(filePath: string): ParsedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: ParsedMessage[] = [];
  let index = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (obj.type !== "message") continue;

    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const rawRole = msg.role as string | undefined;
    const role: ParsedMessage["role"] =
      rawRole === "user" ? "user"
      : rawRole === "assistant" ? "assistant"
      : "tool";

    const content = msg.content;
    const textParts: string[] = [];

    if (Array.isArray(content)) {
      for (const item of content as Array<Record<string, unknown>>) {
        if (item.type === "text" && typeof item.text === "string") {
          textParts.push(item.text);
        } else if (item.type === "toolCall" && typeof item.name === "string") {
          textParts.push(`[tool: ${item.name}]`);
        }
        // toolResult content is already captured as role=tool messages
      }
    } else if (typeof content === "string") {
      textParts.push(content);
    }

    const text = textParts.join("\n").trim();
    if (!text) continue;

    const timestamp =
      typeof obj.timestamp === "string" ? obj.timestamp
      : typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString()
      : "";

    messages.push({ index: ++index, role, text, timestamp });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string | null;
  // list
  includeActive: boolean;
  // get
  sessionKey: string | null;
  showAll: boolean;
  // grep
  pattern: string | null;
  grepSession: string | null;
  maxSessions: number;
  maxMatches: number;
  // shared
  format: "text" | "json";
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    includeActive: false,
    sessionKey: null,
    showAll: false,
    pattern: null,
    grepSession: null,
    maxSessions: 100,
    maxMatches: 50,
    format: "text",
  };

  let i = 0;

  // First non-flag arg is the subcommand
  if (args.length > 0 && !args[0].startsWith("-")) {
    result.subcommand = args[0];
    i = 1;
  }

  // Second non-flag positional depends on subcommand
  // For "get" it's the session key; for "grep" it's the pattern.
  // We collect positionals and assign after flag parsing.
  const positionals: string[] = [];

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--include-active") {
      result.includeActive = true;
    } else if (arg === "--all") {
      result.showAll = true;
    } else if ((arg === "--session" || arg === "-s") && i + 1 < args.length) {
      result.grepSession = args[++i];
    } else if (arg === "--max-sessions" && i + 1 < args.length) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n) && n > 0) result.maxSessions = n;
    } else if (arg === "--max-matches" && i + 1 < args.length) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n) && n > 0) result.maxMatches = n;
    } else if (arg === "--format" && i + 1 < args.length) {
      const f = args[++i];
      if (f === "json") result.format = "json";
    } else if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
    // Unknown flags silently ignored for forward-compatibility

    i++;
  }

  // Assign positionals based on subcommand
  if (result.subcommand === "get" && positionals.length > 0) {
    result.sessionKey = positionals[0];
  } else if (result.subcommand === "grep" && positionals.length > 0) {
    result.pattern = positionals.join(" ");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function usageText(): string {
  return [
    "Usage:",
    "  sessions list [--include-active] [--format json]",
    "  sessions get <key> [--all] [--format json]",
    "  sessions grep <pattern> [--session <key>] [--max-sessions N] [--max-matches N] [--format json]",
    "",
    "Examples:",
    "  sessions list",
    "  sessions get tui:coder:default",
    "  sessions grep \"auth module\"",
    "  sessions grep /refactor/ --max-sessions 20",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

function handleList(
  agentName: string,
  sessionStore: SessionStoreLike,
  parsed: ParsedArgs,
  callerSessionKey: string | undefined
): { output: string; exitCode: number } {
  const sessions = sessionStore.listSessions(agentName); // newest first, no tool sessions

  // Optionally surface the active session if not already in list
  const activeKey = parsed.includeActive ? callerSessionKey : undefined;
  const activeInList = activeKey
    ? sessions.some((s) => {
        const entry = sessionStore.getEntry(activeKey);
        return entry && s.sessionFile === entry.sessionFile;
      })
    : false;

  let activeEntry: SessionEntryLike | undefined;
  if (activeKey && !activeInList) {
    activeEntry = sessionStore.getEntry(activeKey) ?? undefined;
  }

  const total = sessions.length + (activeEntry ? 1 : 0);

  if (total === 0) {
    if (parsed.format === "json") {
      return { output: JSON.stringify({ agentName, sessions: [] }), exitCode: 0 };
    }
    return { output: `No sessions found for agent '${agentName}'.`, exitCode: 0 };
  }

  if (parsed.format === "json") {
    const items = sessions.map((s, i) => ({
      index: i + 1,
      sessionFile: s.sessionFile,
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      firstMessage: s.firstMessage,
      active: false,
    }));
    if (activeEntry) {
      items.unshift({
        index: 0,
        sessionFile: activeEntry.sessionFile,
        sessionId: activeKey!,
        createdAt: activeEntry.createdAt,
        firstMessage: "(active session)",
        active: true,
      });
    }
    return { output: JSON.stringify({ agentName, sessions: items }, null, 2), exitCode: 0 };
  }

  const lines: string[] = [
    `${total} session${total === 1 ? "" : "s"} for agent '${agentName}':`,
    "",
  ];

  if (activeEntry) {
    const date = formatDate(activeEntry.createdAt);
    lines.push(`  ${activeKey!.padEnd(42)}  ${date}  (active)`);
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const date = formatDate(s.createdAt);
    const suffix = i === 0 && !activeEntry ? "  (most recent)" : "";
    // Derive the session key from the store by reverse lookup (best effort via sessionId)
    const key = findKeyForFile(sessionStore, s.sessionFile) ?? s.sessionId;
    lines.push(`  ${key.padEnd(42)}  ${date}${suffix}`);
  }

  return { output: lines.join("\n"), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: get
// ---------------------------------------------------------------------------

function handleGet(
  agentName: string,
  sessionStore: SessionStoreLike,
  parsed: ParsedArgs
): { output: string; exitCode: number } {
  const key = parsed.sessionKey;
  if (!key) {
    return {
      output: ["Error: session key required.", "", "Usage: sessions get <key>"].join("\n"),
      exitCode: 1,
    };
  }

  // Ownership check
  const entry = sessionStore.getEntry(key);
  if (!entry) {
    return {
      output: `Error: Session '${key}' not found.`,
      exitCode: 1,
    };
  }
  if (entry.agentName !== agentName) {
    return {
      output: `Error: Permission denied — session '${key}' belongs to agent '${entry.agentName}', not '${agentName}'.`,
      exitCode: 1,
    };
  }

  if (!existsSync(entry.sessionFile)) {
    return {
      output: `Error: Session file for '${key}' no longer exists on disk.`,
      exitCode: 1,
    };
  }

  const messages = parseSessionFile(entry.sessionFile);

  if (messages.length === 0) {
    if (parsed.format === "json") {
      return { output: JSON.stringify({ key, agentName, messages: [] }), exitCode: 0 };
    }
    return { output: `Session '${key}' exists but has no messages yet.`, exitCode: 0 };
  }

  // Truncate unless --all
  const TRUNCATE_THRESHOLD = 50;
  const TRUNCATE_HEAD = 5;
  const TRUNCATE_TAIL = 5;
  const truncated = !parsed.showAll && messages.length > TRUNCATE_THRESHOLD;
  const displayed = truncated
    ? [...messages.slice(0, TRUNCATE_HEAD), ...messages.slice(-TRUNCATE_TAIL)]
    : messages;
  const omitted = truncated ? messages.length - TRUNCATE_HEAD - TRUNCATE_TAIL : 0;

  if (parsed.format === "json") {
    return {
      output: JSON.stringify(
        {
          key,
          agentName,
          totalMessages: messages.length,
          truncated,
          omitted,
          messages: displayed.map((m) => ({
            index: m.index,
            role: m.role,
            text: m.text,
            timestamp: m.timestamp,
          })),
        },
        null,
        2
      ),
      exitCode: 0,
    };
  }

  const lines: string[] = [
    `Session: ${key}`,
    `Messages: ${messages.length}`,
    "",
  ];

  for (let i = 0; i < displayed.length; i++) {
    const m = displayed[i];
    if (truncated && i === TRUNCATE_HEAD) {
      lines.push(`  ... (${omitted} message${omitted === 1 ? "" : "s"} omitted — use --all to show everything)`);
      lines.push("");
    }
    lines.push(`[${m.index}] ${m.role}`);
    // Indent message body
    const bodyLines = m.text.split("\n");
    for (const bl of bodyLines) {
      lines.push(`  ${bl}`);
    }
    lines.push("");
  }

  return { output: lines.join("\n").trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: grep
// ---------------------------------------------------------------------------

interface GrepMatch {
  sessionKey: string;
  messageIndex: number;
  role: string;
  snippet: string;
  timestamp: string;
}

function handleGrep(
  agentName: string,
  sessionStore: SessionStoreLike,
  parsed: ParsedArgs
): { output: string; exitCode: number } {
  const patternRaw = parsed.pattern;
  if (!patternRaw) {
    return {
      output: ["Error: search pattern required.", "", "Usage: sessions grep <pattern>"].join("\n"),
      exitCode: 1,
    };
  }

  // Build regex: /pattern/ syntax → regex, otherwise literal substring (case-insensitive)
  let regex: RegExp;
  const reMatch = patternRaw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (reMatch) {
    try {
      regex = new RegExp(reMatch[1], reMatch[2] || "i");
    } catch (err) {
      return {
        output: `Error: Invalid regex '${patternRaw}': ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
  } else {
    regex = new RegExp(patternRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  // Resolve sessions to search
  let sessionsToSearch: { key: string; file: string }[];

  if (parsed.grepSession) {
    // Single-session mode — ownership check
    const entry = sessionStore.getEntry(parsed.grepSession);
    if (!entry) {
      return {
        output: `Error: Session '${parsed.grepSession}' not found.`,
        exitCode: 1,
      };
    }
    if (entry.agentName !== agentName) {
      return {
        output: `Error: Permission denied — session '${parsed.grepSession}' belongs to agent '${entry.agentName}', not '${agentName}'.`,
        exitCode: 1,
      };
    }
    sessionsToSearch = [{ key: parsed.grepSession, file: entry.sessionFile }];
  } else {
    // All sessions for agent — apply max-sessions limit (newest first)
    const all = sessionStore.listSessions(agentName);
    const limited = all.slice(0, parsed.maxSessions);
    sessionsToSearch = limited.map((s) => ({
      key: findKeyForFile(sessionStore, s.sessionFile) ?? s.sessionId,
      file: s.sessionFile,
    }));
  }

  const matches: GrepMatch[] = [];
  let limitHit = false;

  outer: for (const { key, file } of sessionsToSearch) {
    if (!existsSync(file)) continue;
    const messages = parseSessionFile(file);
    for (const m of messages) {
      if (regex.test(m.text)) {
        matches.push({
          sessionKey: key,
          messageIndex: m.index,
          role: m.role,
          snippet: makeSnippet(m.text, regex),
          timestamp: m.timestamp,
        });
        if (matches.length >= parsed.maxMatches) {
          limitHit = true;
          break outer;
        }
      }
    }
  }

  const sessionsCapped = !parsed.grepSession && sessionsToSearch.length === parsed.maxSessions;
  // Did the session list get truncated?
  const totalSessions = parsed.grepSession
    ? 1
    : sessionStore.listSessions(agentName).length;
  const sessionLimitNote =
    sessionsCapped && totalSessions > parsed.maxSessions
      ? `(searched ${sessionsToSearch.length} of ${totalSessions} sessions — use --max-sessions to search more)`
      : null;

  if (parsed.format === "json") {
    return {
      output: JSON.stringify(
        {
          pattern: patternRaw,
          agentName,
          matchCount: matches.length,
          matchLimitHit: limitHit,
          sessionLimitNote,
          matches,
        },
        null,
        2
      ),
      exitCode: 0,
    };
  }

  if (matches.length === 0) {
    const scope = parsed.grepSession
      ? `session '${parsed.grepSession}'`
      : `${sessionsToSearch.length} session${sessionsToSearch.length === 1 ? "" : "s"}`;
    const note = sessionLimitNote ? `\n${sessionLimitNote}` : "";
    return {
      output: `No matches for '${patternRaw}' in ${scope}.${note}`,
      exitCode: 0,
    };
  }

  const lines: string[] = [
    `${matches.length} match${matches.length === 1 ? "" : "es"}${limitHit ? ` (limit: ${parsed.maxMatches})` : ""} for '${patternRaw}':`,
    "",
  ];

  for (const m of matches) {
    lines.push(`  ${m.sessionKey}  [msg ${m.messageIndex}]  ${m.role}: ${m.snippet}`);
  }

  if (limitHit) {
    lines.push("");
    lines.push(`(match limit reached — use --max-matches to increase)`);
  }
  if (sessionLimitNote) {
    lines.push("");
    lines.push(sessionLimitNote);
  }

  return { output: lines.join("\n"), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso.slice(0, 16);
  }
}

/** Extract a short snippet around the first match of the regex in text. */
function makeSnippet(text: string, regex: RegExp): string {
  const SNIPPET_LEN = 120;
  const CONTEXT = 40;

  // Find first match position
  const clonedRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "");
  const match = clonedRegex.exec(text);
  if (!match) return text.slice(0, SNIPPET_LEN).replace(/\n/g, " ");

  const start = Math.max(0, match.index - CONTEXT);
  const end = Math.min(text.length, match.index + match[0].length + CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return (prefix + text.slice(start, end) + suffix).replace(/\n/g, " ");
}

/**
 * Reverse-lookup: find the session map key for a given session file path.
 * The sessionStore interface only exposes forward-lookup (key → entry), so
 * we scan the session list for a match via the sessionId embedded in the path.
 */
function findKeyForFile(
  sessionStore: SessionStoreLike,
  filePath: string
): string | null {
  // Extract sessionId from path: .../sessions/<agent>/<sessionId>.jsonl
  const match = filePath.match(/([^/\\]+)\.jsonl$/);
  if (!match) return null;
  const sessionId = match[1];

  // The session key is stored in the session map — but we only have getEntry(key).
  // We need to expose the key somehow. We use a naming convention:
  // try the TUI default key first, then search via listSessions sessionId match.
  // This is a best-effort lookup; the sessionId IS shown as fallback if not found.
  return sessionId;
}

// ---------------------------------------------------------------------------
// createHandler — entry point called by the beige gateway at startup
// ---------------------------------------------------------------------------

export function createHandler(
  _config: Record<string, unknown>,
  context: SessionsContext = {}
): ToolHandler {
  const { sessionStore } = context;

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: IncomingSessionContext
  ): Promise<{ output: string; exitCode: number }> => {
    // ── Session store availability ─────────────────────────────────────────
    if (!sessionStore) {
      return {
        output: "sessions: session store unavailable. This tool requires gateway context.",
        exitCode: 1,
      };
    }

    // ── Identify calling agent ─────────────────────────────────────────────
    const callerSessionKey = sessionContext?.sessionKey;
    const callerEntry = callerSessionKey ? sessionStore.getEntry(callerSessionKey) : undefined;
    const callerAgent =
      sessionContext?.agentName ??
      callerEntry?.agentName ??
      "unknown";

    if (callerAgent === "unknown") {
      return {
        output: [
          "Error: agent identity unknown.",
          "This tool requires BEIGE_AGENT_NAME to be set in the sandbox environment.",
          "Ensure you are running a recent version of beige (>= 0.1.3).",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Parse args ─────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    const parsed = parseArgs(args);

    if (!parsed.subcommand) {
      return {
        output: ["Error: subcommand required.", "", usageText()].join("\n"),
        exitCode: 1,
      };
    }

    // ── Dispatch ───────────────────────────────────────────────────────────
    switch (parsed.subcommand) {
      case "list":
        return handleList(callerAgent, sessionStore, parsed, callerSessionKey);

      case "get":
        return handleGet(callerAgent, sessionStore, parsed);

      case "grep":
        return handleGrep(callerAgent, sessionStore, parsed);

      default:
        return {
          output: [
            `Error: unknown subcommand '${parsed.subcommand}'.`,
            "",
            usageText(),
          ].join("\n"),
          exitCode: 1,
        };
    }
  };
}

// ── Plugin adapter ───────────────────────────────────────────────────────────

import type {
  PluginInstance,
  PluginContext,
  PluginRegistrar,
} from "@matthias-hausberger/beige";
import { readFileSync as readFileSyncPlugin } from "fs";
import { join as joinPath } from "path";

export function createPlugin(
  config: Record<string, unknown>,
  ctx: PluginContext
): PluginInstance {
  const manifestPath = joinPath(import.meta.dirname!, "plugin.json");
  const manifest = JSON.parse(readFileSyncPlugin(manifestPath, "utf-8"));

  // Bridge PluginContext to the SessionStoreLike interface the handler expects
  const sessionStoreBridge: SessionStoreLike = {
    getEntry(key: string) {
      return ctx.getSessionEntry(key) as SessionEntryLike | undefined;
    },
    listSessions(agentName: string, opts?: { includeToolSessions?: boolean }) {
      return ctx.listSessions(agentName, opts) as SessionInfoLike[];
    },
  };

  const handler = createHandler(config, { sessionStore: sessionStoreBridge });

  return {
    register(reg: PluginRegistrar): void {
      reg.tool({
        name: manifest.name,
        description: manifest.description,
        commands: manifest.commands,
        handler,
      });
    },
  };
}
