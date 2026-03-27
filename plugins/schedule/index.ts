/**
 * schedule tool
 *
 * Allows a beige agent to schedule one-off or recurring tasks that trigger
 * back to itself — either as a new agent prompt or as a shell command on the
 * gateway host.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * When an agent calls this tool the gateway:
 *   1. Validates the args and permissions (exec requires allowExec: true).
 *   2. Writes a schedule entry to disk as a JSON file under storagePath.
 *   3. Returns a SCHEDULED: <id> confirmation line.
 *
 * A background tick loop (started via PluginInstance.start()) wakes up every
 * tickInterval seconds and:
 *   1. Reads all schedule files whose status is "active".
 *   2. For each whose nextRun ≤ now:
 *        - "prompt": calls ctx.prompt() for the agent that created the
 *          schedule, with a fresh session key each run.
 *        - "message-file": reads the file then calls ctx.prompt() the same way.
 *        - "exec": calls POST /api/agents/:name/exec on the gateway HTTP API.
 *          This runs the command directly in the agent's sandbox container via
 *          SandboxManager.exec() — no LLM involved, fully audit-logged.
 *   3. Appends a run record to history/<id>-<ts>.json.
 *   4. For "once" schedules: marks status = "completed".
 *   5. For "cron" schedules: advances nextRun; if maxRuns or expiresAt is
 *      reached the status is set to "completed".
 *
 * ── Security model ───────────────────────────────────────────────────────────
 *
 * - An agent can only schedule tasks that trigger itself — the createdBy
 *   field is always the calling agent's identity (resolved from the session
 *   context), never caller-supplied.
 * - exec actions are opt-out behind allowExec: false in the plugin config.
 *   They are safe by default because the command runs inside the agent's own
 *   sandbox via the gateway HTTP API (POST /api/agents/:name/exec) — no LLM
 *   call, no gateway host shell access.
 * - Schedule files live on the gateway host, not in the agent sandbox.
 * - maxSchedulesPerAgent caps how many active schedules one agent can hold.
 *
 * ── Storage layout ───────────────────────────────────────────────────────────
 *
 *   <storagePath>/
 *     schedules/
 *       sched_<id>.json        one file per schedule
 *     history/
 *       sched_<id>-<ts>.json   one file per run
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 *
 * createHandler / createTickFn accept an optional deps argument so tests can
 * inject stubs for the filesystem, clock, and prompt/exec execution without
 * needing a real gateway.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "fs";
import { join as joinPath, resolve as resolvePath } from "path";
import { homedir } from "os";
// ── cron-parser (named import) ────────────────────────────────────────────────
import { CronExpressionParser } from "cron-parser";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleStatus = "active" | "paused" | "completed" | "failed" | "cancelled";
export type ActionType = "prompt" | "message-file" | "exec";

export interface TriggerOnce {
  type: "once";
  /** ISO 8601 UTC string */
  at: string;
}

export interface TriggerCron {
  type: "cron";
  /** Standard 5-field cron expression */
  expression: string;
  /** IANA timezone name, default "UTC" */
  timezone: string;
}

export type Trigger = TriggerOnce | TriggerCron;

export interface ActionPrompt {
  type: "prompt";
  message: string;
}

export interface ActionMessageFile {
  type: "message-file";
  /** Absolute path to the message file, read at trigger time */
  messageFile: string;
}

export interface ActionExec {
  type: "exec";
  command: string;
  /** Working directory, default "/" */
  cwd?: string;
}

export type Action = ActionPrompt | ActionMessageFile | ActionExec;

export interface ScheduleEntry {
  id: string;
  /** Optional human-readable label */
  label?: string;

  /** Agent name that created (and will receive) this schedule */
  createdBy: string;
  createdAt: string;
  /** Session key that created this schedule, stored for audit */
  createdInSession: string;

  trigger: Trigger;
  action: Action;

  status: ScheduleStatus;
  /** Pre-computed ISO string of next trigger time, null when completed */
  nextRun: string | null;
  lastRun: string | null;
  runCount: number;

  /** For cron schedules: stop after this many runs (null = unlimited) */
  maxRuns: number | null;
  /** For cron schedules: stop after this datetime (null = no expiry) */
  expiresAt: string | null;
}

export interface RunRecord {
  scheduleId: string;
  runAt: string;
  /** "success" | "error" */
  status: "success" | "error";
  /** Session key used for prompt/message-file actions */
  sessionKey?: string;
  /** Truncated output (first 2000 chars) */
  output?: string;
  errorMessage?: string;
  durationMs: number;
}

// ── Plugin config ─────────────────────────────────────────────────────────────

export interface ScheduleConfig {
  /** Where to store schedule/history files. Default: ~/.beige/plugins/schedule */
  storagePath?: string;
  /** Tick interval in seconds. Default: 15 */
  tickInterval?: number;
  /** Allow exec-type actions. Default: true */
  allowExec?: boolean;
  /** Max active schedules per agent. Default: 20 */
  maxSchedulesPerAgent?: number;
}

// ── Dependency interfaces (for testing) ───────────────────────────────────────

export interface PromptFn {
  (sessionKey: string, agentName: string, message: string): Promise<string>;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ScheduleDeps {
  /** Override filesystem ops for testing */
  fs?: {
    writeFile(path: string, content: string): void;
    readFile(path: string): string;
    readDir(path: string): string[];
    exists(path: string): boolean;
    ensureDir(path: string): void;
    atomicWrite(path: string, content: string): void;
  };
  /** Override clock for testing */
  now?: () => Date;
  /** Override prompt for testing (used for prompt / message-file actions) */
  promptFn?: PromptFn;
  /**
   * Override sandbox exec for testing (used for exec actions).
   * Production implementation calls POST /api/agents/:name/exec on the
   * gateway HTTP API, which runs the command in the agent's sandbox container
   * via SandboxManager.exec() — no LLM involved.
   */
  execInSandbox?: (agentName: string, command: string) => Promise<SandboxExecResult>;
  /** Override ID generation for testing */
  generateId?: () => string;
}

// ── Session context (injected by beige) ───────────────────────────────────────

export interface IncomingSessionContext {
  sessionKey?: string;
  channel?: string;
  agentName?: string;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: IncomingSessionContext
) => Promise<{ output: string; exitCode: number }>;

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}

/**
 * Resolve the beige home directory using the same priority order as the
 * gateway itself:
 *   1. BEIGE_HOME env var (set by `pnpm run dev` in the beige repo so that
 *      source-checkout runs are self-contained and never touch ~/.beige)
 *   2. ~/.beige (default for npm-global installs)
 *
 * beigeDir() is intentionally not exported from @matthias-hausberger/beige's
 * public index, so we replicate the one-liner here rather than reaching into
 * internal dist paths.
 */
function beigeDir(): string {
  const env = process.env.BEIGE_HOME;
  return env ? resolvePath(env) : resolvePath(homedir(), ".beige");
}

function resolveStoragePath(cfg: ScheduleConfig): string {
  if (cfg.storagePath) {
    return resolvePath(expandTilde(cfg.storagePath));
  }
  // Default: <beige-home>/plugins/schedule — respects BEIGE_HOME so that
  // dev runs (where BEIGE_HOME=./.beige) stay fully self-contained.
  return joinPath(beigeDir(), "plugins", "schedule");
}

// Production filesystem implementation
const realFs: Required<ScheduleDeps>["fs"] = {
  writeFile(path, content) {
    writeFileSync(path, content, "utf-8");
  },
  readFile(path) {
    return readFileSync(path, "utf-8");
  },
  readDir(path) {
    return readdirSync(path);
  },
  exists(path) {
    return existsSync(path);
  },
  ensureDir(path) {
    mkdirSync(path, { recursive: true });
  },
  atomicWrite(path, content) {
    // Write to a temp file then rename for atomicity
    const tmp = path + ".tmp";
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  },
};

function makeStorage(storagePath: string, fs: Required<ScheduleDeps>["fs"]) {
  const schedulesDir = joinPath(storagePath, "schedules");
  const historyDir = joinPath(storagePath, "history");

  function ensureDirs() {
    fs.ensureDir(schedulesDir);
    fs.ensureDir(historyDir);
  }

  function scheduleFilePath(id: string): string {
    return joinPath(schedulesDir, `${id}.json`);
  }

  function saveSchedule(entry: ScheduleEntry): void {
    ensureDirs();
    fs.atomicWrite(scheduleFilePath(entry.id), JSON.stringify(entry, null, 2));
  }

  function loadSchedule(id: string): ScheduleEntry | null {
    const path = scheduleFilePath(id);
    if (!fs.exists(path)) return null;
    try {
      return JSON.parse(fs.readFile(path)) as ScheduleEntry;
    } catch {
      return null;
    }
  }

  function listAllSchedules(): ScheduleEntry[] {
    if (!fs.exists(schedulesDir)) return [];
    const files = fs.readDir(schedulesDir).filter((f) => f.endsWith(".json"));
    const entries: ScheduleEntry[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFile(joinPath(schedulesDir, file));
        entries.push(JSON.parse(raw) as ScheduleEntry);
      } catch {
        // Skip malformed files silently
      }
    }
    return entries;
  }

  function appendHistory(record: RunRecord): void {
    ensureDirs();
    const ts = record.runAt.replace(/[:.]/g, "-");
    const path = joinPath(historyDir, `${record.scheduleId}-${ts}.json`);
    fs.writeFile(path, JSON.stringify(record, null, 2));
  }

  function listHistory(scheduleId: string): RunRecord[] {
    if (!fs.exists(historyDir)) return [];
    const prefix = `${scheduleId}-`;
    const files = fs.readDir(historyDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort()
      .reverse(); // newest first
    const records: RunRecord[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFile(joinPath(historyDir, file));
        records.push(JSON.parse(raw) as RunRecord);
      } catch {
        // Skip malformed
      }
    }
    return records;
  }

  return { saveSchedule, loadSchedule, listAllSchedules, appendHistory, listHistory };
}

// ─────────────────────────────────────────────────────────────────────────────
// ID generation
// ─────────────────────────────────────────────────────────────────────────────

function generateScheduleId(): string {
  return "sched_" + Math.random().toString(36).slice(2, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session key generation for scheduled prompt runs
// ─────────────────────────────────────────────────────────────────────────────

function generateRunSessionKey(scheduleId: string): string {
  const ts = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, "");
  return `schedule:${scheduleId}:${ts}:${Math.random().toString(36).slice(2, 6)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the next run time for a cron trigger after a given date.
 * Returns null if the expression is invalid.
 */
export function getNextCronRun(expression: string, timezone: string, after: Date): Date | null {
  try {
    const iter = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: after,
    });
    return iter.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Validate that a cron expression parses without error.
 */
export function validateCronExpression(expression: string, timezone: string): string | null {
  try {
    CronExpressionParser.parse(expression, { tz: timezone });
    return null; // valid
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

type Subcommand = "create" | "list" | "get" | "cancel" | "pause" | "resume" | "history" | "test";

interface ParsedCreate {
  subcommand: "create";
  // Trigger
  once?: string;         // ISO string
  cron?: string;         // cron expression
  tz?: string;           // IANA timezone
  // Action
  prompt?: string;       // inline message
  messageFile?: string;  // path
  exec?: string;         // shell command
  // Options
  label?: string;
  maxRuns?: number;
  expires?: string;      // ISO string
}

interface ParsedIdCommand {
  subcommand: "get" | "cancel" | "pause" | "resume" | "test";
  id: string;
}

interface ParsedList {
  subcommand: "list";
  status?: string;
  format?: string;
}

interface ParsedHistory {
  subcommand: "history";
  id: string;
  limit?: number;
  format?: string;
}

interface ParsedUnknown {
  subcommand: null;
  error: string;
}

type ParsedArgs =
  | ParsedCreate
  | ParsedIdCommand
  | ParsedList
  | ParsedHistory
  | ParsedUnknown;

export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { subcommand: null, error: "no arguments provided" };
  }

  const sub = args[0];
  const rest = args.slice(1);

  // ── create ──────────────────────────────────────────────────────────────
  if (sub === "create") {
    const result: ParsedCreate = { subcommand: "create" };
    let i = 0;
    while (i < rest.length) {
      const arg = rest[i];
      switch (arg) {
        case "--once":
          result.once = rest[++i];
          break;
        case "--cron":
          result.cron = rest[++i];
          break;
        case "--tz":
          result.tz = rest[++i];
          break;
        case "--prompt": {
          // Consume all remaining args as the message (stop at known flags)
          const parts: string[] = [];
          while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
            parts.push(rest[++i]);
          }
          result.prompt = parts.join(" ");
          break;
        }
        case "--message-file":
          result.messageFile = rest[++i];
          break;
        case "--exec":
          result.exec = rest[++i];
          break;
        case "--label":
          result.label = rest[++i];
          break;
        case "--max-runs":
          result.maxRuns = parseInt(rest[++i], 10);
          break;
        case "--expires":
          result.expires = rest[++i];
          break;
        default:
          // Unknown flag — skip
          break;
      }
      i++;
    }
    return result;
  }

  // ── list ─────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const result: ParsedList = { subcommand: "list" };
    let i = 0;
    while (i < rest.length) {
      if (rest[i] === "--status") result.status = rest[++i];
      else if (rest[i] === "--format") result.format = rest[++i];
      i++;
    }
    return result;
  }

  // ── history ───────────────────────────────────────────────────────────────
  if (sub === "history") {
    if (!rest[0]) return { subcommand: null, error: "history requires <id>" };
    const result: ParsedHistory = { subcommand: "history", id: rest[0] };
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "--limit") result.limit = parseInt(rest[++i], 10);
      else if (rest[i] === "--format") result.format = rest[++i];
      i++;
    }
    return result;
  }

  // ── single-id commands ────────────────────────────────────────────────────
  const idCommands: Subcommand[] = ["get", "cancel", "pause", "resume", "test"];
  if (idCommands.includes(sub as Subcommand)) {
    if (!rest[0]) return { subcommand: null, error: `${sub} requires <id>` };
    return { subcommand: sub as "get" | "cancel" | "pause" | "resume" | "test", id: rest[0] };
  }

  return { subcommand: null, error: `unknown subcommand '${sub}'` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage / help text
// ─────────────────────────────────────────────────────────────────────────────

function usageText(): string {
  return [
    "Usage: schedule <subcommand> [options]",
    "",
    "Subcommands:",
    "  create --once <ISO8601>  --prompt <message...>",
    "  create --once <ISO8601>  --message-file <path>",
    "  create --once <ISO8601>  --exec <command>",
    "  create --cron <expr>  [--tz <tz>]  --prompt <message...>",
    "  create --cron <expr>  [--tz <tz>]  --message-file <path>",
    "  create --cron <expr>  [--tz <tz>]  --exec <command>",
    "  create  ...  [--label <text>]  [--max-runs <n>]  [--expires <ISO8601>]",
    "",
    "  list    [--status active|paused|completed|all]  [--format json]",
    "  get     <id>",
    "  cancel  <id>",
    "  pause   <id>",
    "  resume  <id>",
    "  history <id>  [--limit <n>]  [--format json]",
    "  test    <id>    — trigger immediately regardless of nextRun",
    "",
    "Examples:",
    '  schedule create --once 2026-03-28T09:00:00Z --prompt "Check the build status"',
    '  schedule create --cron "0 9 * * 1-5" --tz "Europe/Vienna" --message-file /workspace/morning.md',
    '  schedule create --cron "0 * * * *" --exec "node /workspace/scripts/sync.mjs"',
    "  schedule list",
    "  schedule cancel sched_a1b2c3",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSchedule(entry: ScheduleEntry): string {
  const lines: string[] = [
    `ID:         ${entry.id}`,
    `Status:     ${entry.status}`,
  ];
  if (entry.label) lines.push(`Label:      ${entry.label}`);
  lines.push(`Created by: ${entry.createdBy}`);
  lines.push(`Created at: ${entry.createdAt}`);

  // Trigger
  if (entry.trigger.type === "once") {
    lines.push(`Trigger:    once at ${entry.trigger.at}`);
  } else {
    lines.push(`Trigger:    cron "${entry.trigger.expression}" (tz: ${entry.trigger.timezone})`);
  }

  // Action
  if (entry.action.type === "prompt") {
    const preview = entry.action.message.length > 80
      ? entry.action.message.slice(0, 77) + "…"
      : entry.action.message;
    lines.push(`Action:     prompt — "${preview}"`);
  } else if (entry.action.type === "message-file") {
    lines.push(`Action:     message-file — ${entry.action.messageFile}`);
  } else {
    lines.push(`Action:     exec — ${entry.action.command}`);
  }

  lines.push(`Next run:   ${entry.nextRun ?? "(none)"}`);
  lines.push(`Last run:   ${entry.lastRun ?? "(never)"}`);
  lines.push(`Run count:  ${entry.runCount}`);
  if (entry.maxRuns !== null) lines.push(`Max runs:   ${entry.maxRuns}`);
  if (entry.expiresAt !== null) lines.push(`Expires:    ${entry.expiresAt}`);
  return lines.join("\n");
}

function formatScheduleSummary(entry: ScheduleEntry): string {
  const trigger =
    entry.trigger.type === "once"
      ? `once @ ${entry.trigger.at}`
      : `cron "${entry.trigger.expression}"`;
  const label = entry.label ? ` (${entry.label})` : "";
  return `${entry.id}${label}  [${entry.status}]  ${trigger}  next: ${entry.nextRun ?? "—"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox exec via gateway HTTP API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a command in an agent's sandbox by calling the gateway HTTP API.
 *
 * The gateway exposes POST /api/agents/:name/exec which routes to
 * SandboxManager.exec() — no LLM is involved, the command runs directly in
 * the Docker container, and the gateway audit-logs the call.
 *
 * The port defaults to 7433 and is configurable via config.gateway.port.
 * Since plugins run inside the gateway process, 127.0.0.1 is always reachable.
 */
async function execViaGatewayApi(
  agentName: string,
  command: string,
  gatewayPort: number
): Promise<SandboxExecResult> {
  const url = `http://127.0.0.1:${gatewayPort}/api/agents/${encodeURIComponent(agentName)}/exec`;
  const body = JSON.stringify({ tool: "exec", params: { command } });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`gateway exec API error (${res.status}): ${text}`);
  }

  // The API returns the same shape as a tool result: { content: [{ type, text }] }
  // stdout/stderr/exitCode are embedded in the text; we surface it as-is.
  const json = await res.json() as { content?: Array<{ type: string; text: string }>; exitCode?: number; stdout?: string; stderr?: string };

  // Normalise: newer API returns stdout/stderr/exitCode directly;
  // fallback to extracting text from content array for older shape.
  const stdout = json.stdout ?? json.content?.map((c) => c.text).join("") ?? "";
  const stderr = json.stderr ?? "";
  const exitCode = json.exitCode ?? 0;

  return { stdout, stderr, exitCode };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick loop — executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a single due schedule entry.
 * Returns a RunRecord. Mutates the entry (runCount, lastRun, nextRun, status).
 *
 * prompt / message-file actions go through ctx.prompt() — a new agent session
 * is created and the agent responds inside its sandbox.
 *
 * exec actions go through the gateway HTTP API (POST /api/agents/:name/exec)
 * which calls SandboxManager.exec() directly — no LLM involved, fully
 * audit-logged by the gateway.
 */
async function executeSchedule(
  entry: ScheduleEntry,
  cfg: ScheduleConfig,
  deps: Required<ScheduleDeps>,
  log: (msg: string) => void
): Promise<RunRecord> {
  const runAt = deps.now().toISOString();
  const start = Date.now();

  let status: "success" | "error" = "success";
  let output: string | undefined;
  let sessionKey: string | undefined;
  let errorMessage: string | undefined;

  try {
    if (entry.action.type === "exec") {
      // ── Direct sandbox exec — no LLM ──────────────────────────────────
      if (cfg.allowExec === false) {
        throw new Error("exec actions are disabled (allowExec is false in plugin config)");
      }
      log(`running schedule ${entry.id} (exec in sandbox → ${entry.createdBy}: ${entry.action.command})`);
      const result = await deps.execInSandbox(entry.createdBy, entry.action.command);
      const combined = [result.stdout, result.stderr ? `stderr: ${result.stderr}` : ""]
        .filter(Boolean).join("\n");
      output = combined.slice(0, 2000);
      if (result.exitCode !== 0) {
        throw new Error(`command exited with code ${result.exitCode}:\n${result.stderr || result.stdout}`);
      }

    } else {
      // ── Prompt / message-file — goes through ctx.prompt() ─────────────
      let message: string;
      if (entry.action.type === "message-file") {
        if (!deps.fs.exists(entry.action.messageFile)) {
          throw new Error(`message file not found: ${entry.action.messageFile}`);
        }
        message = deps.fs.readFile(entry.action.messageFile).trim();
        if (!message) {
          throw new Error(`message file is empty: ${entry.action.messageFile}`);
        }
      } else {
        message = entry.action.message;
      }
      sessionKey = generateRunSessionKey(entry.id);
      log(`running schedule ${entry.id} (${entry.action.type} → ${entry.createdBy}, session ${sessionKey})`);
      const response = await deps.promptFn(sessionKey, entry.createdBy, message);
      output = response.slice(0, 2000);
    }

  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    log(`schedule ${entry.id} failed: ${errorMessage}`);
  }

  const durationMs = Date.now() - start;

  // Update the entry
  entry.runCount += 1;
  entry.lastRun = runAt;

  if (entry.trigger.type === "once") {
    entry.status = "completed";
    entry.nextRun = null;
  } else {
    // Cron: advance nextRun
    const next = getNextCronRun(
      entry.trigger.expression,
      entry.trigger.timezone,
      deps.now()
    );

    const limitReached =
      (entry.maxRuns !== null && entry.runCount >= entry.maxRuns) ||
      (entry.expiresAt !== null && next !== null && next.toISOString() > entry.expiresAt) ||
      next === null;

    if (limitReached) {
      entry.status = "completed";
      entry.nextRun = null;
    } else {
      entry.nextRun = next!.toISOString();
    }
  }

  return {
    scheduleId: entry.id,
    runAt,
    status,
    sessionKey,
    output,
    errorMessage,
    durationMs,
  };
}

/**
 * One tick of the background loop.
 * Loads all active schedules, fires any that are due, saves updated entries.
 */
export async function runTick(
  storage: ReturnType<typeof makeStorage>,
  cfg: ScheduleConfig,
  deps: Required<ScheduleDeps>,
  log: (msg: string) => void
): Promise<void> {
  const now = deps.now();
  const all = storage.listAllSchedules();
  const due = all.filter(
    (e) => e.status === "active" && e.nextRun !== null && new Date(e.nextRun) <= now
  );

  for (const entry of due) {
    const record = await executeSchedule(entry, cfg, deps, log);
    storage.saveSchedule(entry); // persists updated status / nextRun
    storage.appendHistory(record);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleCreate(
  parsed: ParsedCreate,
  callerAgent: string,
  callerSessionKey: string,
  cfg: ScheduleConfig,
  storage: ReturnType<typeof makeStorage>,
  deps: Required<ScheduleDeps>
): { output: string; exitCode: number } {
  // ── Validate trigger ───────────────────────────────────────────────────────
  if (!parsed.once && !parsed.cron) {
    return { output: "Error: --once <ISO8601> or --cron <expr> is required.\n\n" + usageText(), exitCode: 1 };
  }
  if (parsed.once && parsed.cron) {
    return { output: "Error: --once and --cron are mutually exclusive.", exitCode: 1 };
  }

  // ── Validate action ────────────────────────────────────────────────────────
  const actionCount = [parsed.prompt, parsed.messageFile, parsed.exec].filter(Boolean).length;
  if (actionCount === 0) {
    return { output: "Error: --prompt <message>, --message-file <path>, or --exec <command> is required.\n\n" + usageText(), exitCode: 1 };
  }
  if (actionCount > 1) {
    return { output: "Error: --prompt, --message-file, and --exec are mutually exclusive.", exitCode: 1 };
  }

  // ── Validate exec permission ───────────────────────────────────────────────
  if (parsed.exec && cfg.allowExec === false) {
    return {
      output: [
        "Error: exec actions are disabled.",
        "Set allowExec: true in the schedule plugin config to enable shell commands.",
      ].join("\n"),
      exitCode: 1,
    };
  }

  // ── Validate prompt message non-empty ─────────────────────────────────────
  if (parsed.prompt !== undefined && parsed.prompt.trim() === "") {
    return { output: "Error: --prompt message cannot be empty.", exitCode: 1 };
  }

  // ── Build trigger ──────────────────────────────────────────────────────────
  let trigger: Trigger;
  let initialNextRun: string;

  if (parsed.once) {
    const d = new Date(parsed.once);
    if (isNaN(d.getTime())) {
      return { output: `Error: invalid ISO 8601 datetime for --once: "${parsed.once}"`, exitCode: 1 };
    }
    if (d <= deps.now()) {
      return { output: `Error: --once datetime "${parsed.once}" is in the past.`, exitCode: 1 };
    }
    trigger = { type: "once", at: d.toISOString() };
    initialNextRun = d.toISOString();

  } else {
    const tz = parsed.tz ?? "UTC";
    const cronErr = validateCronExpression(parsed.cron!, tz);
    if (cronErr) {
      return { output: `Error: invalid cron expression "${parsed.cron}": ${cronErr}`, exitCode: 1 };
    }
    const next = getNextCronRun(parsed.cron!, tz, deps.now());
    if (!next) {
      return { output: `Error: cron expression "${parsed.cron}" produces no future runs.`, exitCode: 1 };
    }
    trigger = { type: "cron", expression: parsed.cron!, timezone: tz };
    initialNextRun = next.toISOString();
  }

  // ── Validate maxRuns / expires ─────────────────────────────────────────────
  if (parsed.maxRuns !== undefined && (isNaN(parsed.maxRuns) || parsed.maxRuns < 1)) {
    return { output: "Error: --max-runs must be a positive integer.", exitCode: 1 };
  }
  if (parsed.expires) {
    const d = new Date(parsed.expires);
    if (isNaN(d.getTime())) {
      return { output: `Error: invalid ISO 8601 datetime for --expires: "${parsed.expires}"`, exitCode: 1 };
    }
  }

  // ── Check per-agent quota ──────────────────────────────────────────────────
  const maxPerAgent = cfg.maxSchedulesPerAgent ?? 20;
  const existing = storage.listAllSchedules().filter(
    (e) => e.createdBy === callerAgent && (e.status === "active" || e.status === "paused")
  );
  if (existing.length >= maxPerAgent) {
    return {
      output: [
        `Error: you have reached the maximum of ${maxPerAgent} active schedules.`,
        "Cancel or complete some existing schedules before creating new ones.",
        "",
        `Your active schedules (${existing.length}):`,
        ...existing.map((e) => `  ${formatScheduleSummary(e)}`),
      ].join("\n"),
      exitCode: 1,
    };
  }

  // ── Build action ──────────────────────────────────────────────────────────
  let action: Action;
  if (parsed.prompt !== undefined) {
    action = { type: "prompt", message: parsed.prompt };
  } else if (parsed.messageFile) {
    action = { type: "message-file", messageFile: parsed.messageFile };
  } else {
    action = { type: "exec", command: parsed.exec! };
  }

  // ── Build and save entry ───────────────────────────────────────────────────
  const entry: ScheduleEntry = {
    id: deps.generateId(),
    label: parsed.label,
    createdBy: callerAgent,
    createdAt: deps.now().toISOString(),
    createdInSession: callerSessionKey,
    trigger,
    action,
    status: "active",
    nextRun: initialNextRun,
    lastRun: null,
    runCount: 0,
    maxRuns: parsed.maxRuns ?? null,
    expiresAt: parsed.expires ? new Date(parsed.expires).toISOString() : null,
  };

  storage.saveSchedule(entry);

  return {
    output: [
      `SCHEDULED: ${entry.id}`,
      "",
      formatSchedule(entry),
    ].join("\n"),
    exitCode: 0,
  };
}

function handleList(
  callerAgent: string,
  parsed: ParsedList,
  storage: ReturnType<typeof makeStorage>
): { output: string; exitCode: number } {
  const statusFilter = parsed.status ?? "active";
  const all = storage.listAllSchedules().filter((e) => e.createdBy === callerAgent);
  const filtered =
    statusFilter === "all"
      ? all
      : all.filter((e) => e.status === statusFilter);

  // Sort: active first, then by nextRun ascending
  filtered.sort((a, b) => {
    if (a.status !== b.status) {
      const order: ScheduleStatus[] = ["active", "paused", "completed", "failed", "cancelled"];
      return order.indexOf(a.status) - order.indexOf(b.status);
    }
    if (a.nextRun && b.nextRun) return a.nextRun.localeCompare(b.nextRun);
    return 0;
  });

  if (parsed.format === "json") {
    return { output: JSON.stringify(filtered, null, 2), exitCode: 0 };
  }

  if (filtered.length === 0) {
    const qualifier = statusFilter === "all" ? "" : ` ${statusFilter}`;
    return { output: `No${qualifier} schedules found.`, exitCode: 0 };
  }

  return {
    output: filtered.map(formatScheduleSummary).join("\n"),
    exitCode: 0,
  };
}

function handleGet(
  id: string,
  callerAgent: string,
  storage: ReturnType<typeof makeStorage>
): { output: string; exitCode: number } {
  const entry = storage.loadSchedule(id);
  if (!entry) {
    return { output: `Error: schedule '${id}' not found.`, exitCode: 1 };
  }
  if (entry.createdBy !== callerAgent) {
    return { output: `Error: schedule '${id}' does not belong to you.`, exitCode: 1 };
  }
  return { output: formatSchedule(entry), exitCode: 0 };
}

function handleCancel(
  id: string,
  callerAgent: string,
  storage: ReturnType<typeof makeStorage>
): { output: string; exitCode: number } {
  const entry = storage.loadSchedule(id);
  if (!entry) return { output: `Error: schedule '${id}' not found.`, exitCode: 1 };
  if (entry.createdBy !== callerAgent) return { output: `Error: schedule '${id}' does not belong to you.`, exitCode: 1 };
  if (entry.status === "cancelled") return { output: `Schedule '${id}' is already cancelled.`, exitCode: 0 };
  if (entry.status === "completed") return { output: `Error: schedule '${id}' has already completed and cannot be cancelled.`, exitCode: 1 };

  entry.status = "cancelled";
  entry.nextRun = null;
  storage.saveSchedule(entry);
  return { output: `Cancelled: ${id}`, exitCode: 0 };
}

function handlePause(
  id: string,
  callerAgent: string,
  storage: ReturnType<typeof makeStorage>
): { output: string; exitCode: number } {
  const entry = storage.loadSchedule(id);
  if (!entry) return { output: `Error: schedule '${id}' not found.`, exitCode: 1 };
  if (entry.createdBy !== callerAgent) return { output: `Error: schedule '${id}' does not belong to you.`, exitCode: 1 };
  if (entry.status !== "active") return { output: `Error: schedule '${id}' is ${entry.status} — only active schedules can be paused.`, exitCode: 1 };

  entry.status = "paused";
  storage.saveSchedule(entry);
  return { output: `Paused: ${id}`, exitCode: 0 };
}

function handleResume(
  id: string,
  callerAgent: string,
  storage: ReturnType<typeof makeStorage>,
  deps: Required<ScheduleDeps>,
  cfg: ScheduleConfig
): { output: string; exitCode: number } {
  const entry = storage.loadSchedule(id);
  if (!entry) return { output: `Error: schedule '${id}' not found.`, exitCode: 1 };
  if (entry.createdBy !== callerAgent) return { output: `Error: schedule '${id}' does not belong to you.`, exitCode: 1 };
  if (entry.status !== "paused") return { output: `Error: schedule '${id}' is ${entry.status} — only paused schedules can be resumed.`, exitCode: 1 };

  // Re-compute nextRun in case it has drifted while paused
  if (entry.trigger.type === "cron") {
    const next = getNextCronRun(entry.trigger.expression, entry.trigger.timezone, deps.now());
    if (!next) {
      return { output: `Error: cron expression "${entry.trigger.expression}" produces no future runs.`, exitCode: 1 };
    }
    entry.nextRun = next.toISOString();
  }

  entry.status = "active";
  storage.saveSchedule(entry);
  return { output: [`Resumed: ${id}`, `Next run: ${entry.nextRun}`].join("\n"), exitCode: 0 };
}

function handleHistory(
  id: string,
  callerAgent: string,
  parsed: ParsedHistory,
  storage: ReturnType<typeof makeStorage>
): { output: string; exitCode: number } {
  const entry = storage.loadSchedule(id);
  if (!entry) return { output: `Error: schedule '${id}' not found.`, exitCode: 1 };
  if (entry.createdBy !== callerAgent) return { output: `Error: schedule '${id}' does not belong to you.`, exitCode: 1 };

  let records = storage.listHistory(id);
  const limit = parsed.limit ?? 20;
  records = records.slice(0, limit);

  if (parsed.format === "json") {
    return { output: JSON.stringify(records, null, 2), exitCode: 0 };
  }

  if (records.length === 0) {
    return { output: `No run history for schedule '${id}'.`, exitCode: 0 };
  }

  const lines = records.map((r) => {
    const icon = r.status === "success" ? "✓" : "✗";
    const dur = `${r.durationMs}ms`;
    const sess = r.sessionKey ? ` session=${r.sessionKey}` : "";
    const err = r.errorMessage ? `  ERROR: ${r.errorMessage}` : "";
    return `${icon} ${r.runAt}  (${dur})${sess}${err}`;
  });

  return {
    output: [
      `Run history for ${id} (showing ${records.length}):`,
      "",
      ...lines,
    ].join("\n"),
    exitCode: 0,
  };
}

async function handleTest(
  id: string,
  callerAgent: string,
  storage: ReturnType<typeof makeStorage>,
  cfg: ScheduleConfig,
  deps: Required<ScheduleDeps>,
  log: (msg: string) => void
): Promise<{ output: string; exitCode: number }> {
  const entry = storage.loadSchedule(id);
  if (!entry) return { output: `Error: schedule '${id}' not found.`, exitCode: 1 };
  if (entry.createdBy !== callerAgent) return { output: `Error: schedule '${id}' does not belong to you.`, exitCode: 1 };
  if (entry.status === "cancelled") return { output: `Error: schedule '${id}' is cancelled.`, exitCode: 1 };

  // Clone entry so test doesn't mutate the saved schedule's runCount/lastRun/status
  const clone: ScheduleEntry = JSON.parse(JSON.stringify(entry));
  const record = await executeSchedule(clone, cfg, deps, log);

  // Persist only the history record, not the mutated clone
  storage.appendHistory(record);

  const icon = record.status === "success" ? "✓" : "✗";
  const lines = [
    `Test run for ${id}: ${icon} ${record.status}  (${record.durationMs}ms)`,
  ];
  if (record.sessionKey) lines.push(`Session: ${record.sessionKey}`);
  if (record.errorMessage) lines.push(`Error: ${record.errorMessage}`);
  if (record.output) lines.push("", "Output (truncated):", record.output.slice(0, 500));

  return { output: lines.join("\n"), exitCode: record.status === "success" ? 0 : 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// createHandler — entry point for tests and the gateway
// ─────────────────────────────────────────────────────────────────────────────

export function createHandler(
  cfg: ScheduleConfig,
  deps: Partial<ScheduleDeps> = {}
): ToolHandler {
  const resolvedDeps: Required<ScheduleDeps> = {
    fs: deps.fs ?? realFs,
    now: deps.now ?? (() => new Date()),
    promptFn: deps.promptFn ?? (async () => { throw new Error("promptFn not configured"); }),
    execInSandbox: deps.execInSandbox ?? (async () => { throw new Error("execInSandbox not configured"); }),
    generateId: deps.generateId ?? generateScheduleId,
  };

  const storagePath = resolveStoragePath(cfg);
  const storage = makeStorage(storagePath, resolvedDeps.fs);

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: IncomingSessionContext
  ): Promise<{ output: string; exitCode: number }> => {
    // ── Resolve calling agent identity ────────────────────────────────────
    const callerAgent = sessionContext?.agentName ?? "unknown";
    const callerSessionKey = sessionContext?.sessionKey ?? "unknown";

    if (callerAgent === "unknown") {
      return {
        output: [
          "Error: agent identity unknown.",
          "This tool requires BEIGE_AGENT_NAME to be set in the session context.",
          "Ensure you are running a recent version of beige (>= 0.1.3).",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Show usage on no args ─────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Parse ─────────────────────────────────────────────────────────────
    const parsed = parseArgs(args);

    if (!parsed.subcommand) {
      return {
        output: [`Error: ${(parsed as ParsedUnknown).error}`, "", usageText()].join("\n"),
        exitCode: 1,
      };
    }

    // ── Dispatch ──────────────────────────────────────────────────────────
    switch (parsed.subcommand) {
      case "create":
        return handleCreate(parsed, callerAgent, callerSessionKey, cfg, storage, resolvedDeps);

      case "list":
        return handleList(callerAgent, parsed, storage);

      case "get":
        return handleGet(parsed.id, callerAgent, storage);

      case "cancel":
        return handleCancel(parsed.id, callerAgent, storage);

      case "pause":
        return handlePause(parsed.id, callerAgent, storage);

      case "resume":
        return handleResume(parsed.id, callerAgent, storage, resolvedDeps, cfg);

      case "history":
        return handleHistory(parsed.id, callerAgent, parsed, storage);

      case "test":
        return handleTest(
          parsed.id,
          callerAgent,
          storage,
          cfg,
          resolvedDeps,
          (msg) => console.log(`[schedule] ${msg}`)
        );
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createTickFn — exported so tests can drive the tick loop directly
// ─────────────────────────────────────────────────────────────────────────────

export function createTickFn(
  cfg: ScheduleConfig,
  deps: Required<ScheduleDeps>,
  log: (msg: string) => void
): () => Promise<void> {
  const storagePath = resolveStoragePath(cfg);
  const storage = makeStorage(storagePath, deps.fs);
  return () => runTick(storage, cfg, deps, log);
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin adapter
// ─────────────────────────────────────────────────────────────────────────────

import type {
  PluginInstance,
  PluginContext,
  PluginRegistrar,
} from "@matthias-hausberger/beige";
import { readFileSync as readFileSyncImport } from "fs";
import { join as joinPathImport } from "path";

export function createPlugin(
  config: Record<string, unknown>,
  ctx: PluginContext
): PluginInstance {
  const manifestPath = joinPathImport(import.meta.dirname!, "plugin.json");
  const manifest = JSON.parse(readFileSyncImport(manifestPath, "utf-8"));

  const cfg = config as ScheduleConfig;

  // Bridge ctx.prompt to the PromptFn interface the handler expects
  const promptFn: PromptFn = (sessionKey, agentName, message) =>
    ctx.prompt(sessionKey, agentName, message, { channel: "schedule" });

  // Resolve gateway port from config for the exec sandbox API
  const beigeConfig = ctx.config as { gateway?: { port?: number } };
  const gatewayPort = beigeConfig.gateway?.port ?? 7433;

  const resolvedDeps: Required<ScheduleDeps> = {
    fs: realFs,
    now: () => new Date(),
    promptFn,
    execInSandbox: (agentName, command) => execViaGatewayApi(agentName, command, gatewayPort),
    generateId: generateScheduleId,
  };

  const storagePath = resolveStoragePath(cfg);
  const storage = makeStorage(storagePath, resolvedDeps.fs);

  const handler = createHandler(cfg, resolvedDeps);

  let tickInterval: ReturnType<typeof setInterval> | null = null;

  return {
    register(reg: PluginRegistrar): void {
      reg.tool({
        name: manifest.name,
        description: manifest.description,
        commands: manifest.commands,
        handler,
      });
    },

    async start(): Promise<void> {
      const intervalSec = cfg.tickInterval ?? 15;
      ctx.log.info(`schedule: tick loop starting (interval: ${intervalSec}s, storage: ${storagePath})`);

      // Run once at startup to catch any schedules that fired while the gateway was down
      try {
        await runTick(storage, cfg, resolvedDeps, (msg) => ctx.log.info(msg));
      } catch (err) {
        ctx.log.error(`schedule: startup tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      tickInterval = setInterval(async () => {
        try {
          await runTick(storage, cfg, resolvedDeps, (msg) => ctx.log.info(msg));
        } catch (err) {
          ctx.log.error(`schedule: tick error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, intervalSec * 1000);
    },

    async stop(): Promise<void> {
      if (tickInterval !== null) {
        clearInterval(tickInterval);
        tickInterval = null;
        ctx.log.info("schedule: tick loop stopped");
      }
    },
  };
}
