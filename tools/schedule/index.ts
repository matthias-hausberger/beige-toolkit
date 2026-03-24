/**
 * schedule tool
 *
 * Lets beige agents create and manage scheduled tasks that trigger prompts.
 *
 * ── Subcommands ─────────────────────────────────────────────────────────────
 *
 *   create <cron> <message...>   Create a new scheduled task.
 *   list                         List all schedules for this agent.
 *   delete <id>                  Delete a schedule.
 *   enable <id>                  Enable a disabled schedule.
 *   disable <id>                 Disable a schedule temporarily.
 *   show <id>                    Show schedule details.
 *   test <cron>                  Show next 5 run times for a cron expression.
 *
 * ── Cron Expressions ────────────────────────────────────────────────────────
 *
 * Standard 5-field cron format:
 *   ┌───────────── minute (0-59)
 *   │ ┌───────────── hour (0-23)
 *   │ │ ┌───────────── day of month (1-31)
 *   │ │ │ ┌───────────── month (1-12)
 *   │ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Examples:
 *   0 9 * * *       Every day at 9:00 AM
 *   */30 * * * *    Every 30 minutes
 *   0 0 * * 0       Every Sunday at midnight
 *   0 14 * * 1-5    Weekdays at 2:00 PM
 *
 * ── Security model ──────────────────────────────────────────────────────────
 *
 * Each agent can only see and manage its own schedules. The agent name is
 * resolved from sessionContext.agentName (injected by beige as BEIGE_AGENT_NAME).
 *
 * ── Persistence ──────────────────────────────────────────────────────────────
 *
 * Schedules are stored in a JSON file on the gateway host. The scheduler
 * service (running in the gateway) reads this file and triggers prompts
 * when schedules are due.
 *
 * ── Dependency injection ────────────────────────────────────────────────────
 *
 * createHandler accepts an optional context argument for testing:
 *
 *   { scheduleStore?, agentManager? }
 *
 * In production beige injects the real store and manager via ToolHandlerContext.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types — self-contained, no beige source imports.
// ---------------------------------------------------------------------------

/** Schedule configuration stored on disk. */
export interface Schedule {
  id: string;
  agentName: string;
  sessionKey: string;
  cronExpression: string;
  message: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  nextRun?: string;
  runCount: number;
  metadata?: Record<string, unknown>;
}

/** Store interface for dependency injection. */
export interface ScheduleStoreLike {
  getSchedules(agentName: string): Schedule[];
  getAllSchedules(): Schedule[];
  getSchedule(id: string): Schedule | undefined;
  saveSchedule(schedule: Schedule): void;
  deleteSchedule(id: string): boolean;
  updateSchedule(id: string, updates: Partial<Schedule>): boolean;
}

/** Agent manager interface for triggering prompts. */
export interface AgentManagerLike {
  prompt(sessionKey: string, agentName: string, message: string): Promise<void>;
}

/** Context injected by the gateway. */
export interface ScheduleContext {
  scheduleStore?: ScheduleStoreLike;
  agentManager?: AgentManagerLike;
  beigeConfig?: Record<string, unknown>;
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
// Cron expression parser (simplified - supports standard 5-field format)
// ---------------------------------------------------------------------------

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  for (const part of field.split(",")) {
    let step = 1;
    let range: string;

    if (part.includes("/")) {
      const [rangePart, stepPart] = part.split("/");
      range = rangePart;
      step = parseInt(stepPart, 10);
      if (isNaN(step) || step < 1) {
        throw new Error(`Invalid step value: ${stepPart}`);
      }
    } else {
      range = part;
    }

    let start: number, end: number;

    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [startStr, endStr] = range.split("-");
      start = parseInt(startStr, 10);
      end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range: ${range}`);
      }
    } else {
      start = parseInt(range, 10);
      end = start;
    }

    if (start < min || end > max || start > end) {
      throw new Error(`Range ${range} out of bounds [${min}, ${max}]`);
    }

    for (let v = start; v <= end; v += step) {
      values.push(v);
    }
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

function parseCronExpression(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields, got ${fields.length}: "${expression}"`
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6),
  };
}

function matchesCron(date: Date, fields: CronFields): boolean {
  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    fields.month.includes(date.getMonth() + 1) &&
    (fields.dayOfMonth.includes(date.getDate()) ||
      fields.dayOfWeek.includes(date.getDay()))
  );
}

function getNextRuns(expression: string, count: number = 5, from?: Date): Date[] {
  const fields = parseCronExpression(expression);
  const runs: Date[] = [];
  let current = from ? new Date(from) : new Date();
  current.setSeconds(0);
  current.setMilliseconds(0);
  current.setMinutes(current.getMinutes() + 1); // Start from next minute

  // Max iterations to prevent infinite loops
  const maxIterations = 366 * 24 * 60; // 1 year of minutes
  let iterations = 0;

  while (runs.length < count && iterations < maxIterations) {
    if (matchesCron(current, fields)) {
      runs.push(new Date(current));
    }
    current.setMinutes(current.getMinutes() + 1);
    iterations++;
  }

  return runs;
}

function isValidCron(expression: string): { valid: boolean; error?: string } {
  try {
    parseCronExpression(expression);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string | null;
  // create
  cronExpression: string | null;
  message: string | null;
  // list
  // (no extra options)
  // delete/enable/disable/show
  scheduleId: string | null;
  // test
  testExpression: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    cronExpression: null,
    message: null,
    scheduleId: null,
    testExpression: null,
  };

  if (args.length === 0) return result;

  // First non-flag arg is the subcommand
  const subcommand = args[0];
  result.subcommand = subcommand;

  if (subcommand === "create" && args.length >= 3) {
    result.cronExpression = args[1];
    result.message = args.slice(2).join(" ");
  } else if (subcommand === "test" && args.length >= 2) {
    result.testExpression = args.slice(1).join(" ");
  } else if (["delete", "enable", "disable", "show"].includes(subcommand) && args.length >= 2) {
    result.scheduleId = args[1];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function usageText(): string {
  return [
    "Usage:",
    "  schedule create <cron-expression> <message...>  — Create a scheduled task",
    "  schedule list                                    — List your schedules",
    "  schedule delete <id>                             — Delete a schedule",
    "  schedule enable <id>                             — Enable a schedule",
    "  schedule disable <id>                            — Disable a schedule",
    "  schedule show <id>                               — Show schedule details",
    "  schedule test <cron-expression>                  — Show next run times",
    "",
    "Cron format: minute hour day-of-month month day-of-week",
    "",
    "Examples:",
    "  schedule create '0 9 * * *' 'Good morning! Time for daily review.'",
    "  schedule create '*/30 * * * *' 'Check status'",
    "  schedule list",
    "  schedule test '0 9 * * 1-5'",
    "",
    "Note: Schedules run in the gateway's timezone (default: UTC).",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: create
// ---------------------------------------------------------------------------

function handleCreate(
  agentName: string,
  sessionKey: string,
  store: ScheduleStoreLike,
  parsed: ParsedArgs,
  config: Record<string, unknown>
): { output: string; exitCode: number } {
  if (!parsed.cronExpression || !parsed.message) {
    return {
      output: ["Error: Both cron expression and message are required.", "", usageText()].join("\n"),
      exitCode: 1,
    };
  }

  // Validate cron expression
  const validation = isValidCron(parsed.cronExpression);
  if (!validation.valid) {
    return {
      output: `Error: Invalid cron expression: ${validation.error}`,
      exitCode: 1,
    };
  }

  // Check schedule limit
  const maxSchedules = (config.maxSchedulesPerAgent as number) ?? 100;
  const currentSchedules = store.getSchedules(agentName);
  if (currentSchedules.length >= maxSchedules) {
    return {
      output: `Error: Maximum number of schedules reached (${maxSchedules}). Delete some schedules first.`,
      exitCode: 1,
    };
  }

  // Calculate next run
  const nextRuns = getNextRuns(parsed.cronExpression, 1);
  const nextRun = nextRuns[0]?.toISOString();

  // Create schedule
  const schedule: Schedule = {
    id: randomUUID(),
    agentName,
    sessionKey,
    cronExpression: parsed.cronExpression,
    message: parsed.message,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRun,
    runCount: 0,
  };

  store.saveSchedule(schedule);

  const lines = [
    "Schedule created successfully!",
    "",
    `  ID: ${schedule.id}`,
    `  Cron: ${schedule.cronExpression}`,
    `  Message: ${schedule.message}`,
    `  Next run: ${nextRun ? formatDate(nextRun) : "Unable to calculate"}`,
    "",
    "Use 'schedule list' to see all your schedules.",
  ];

  return { output: lines.join("\n"), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

function handleList(
  agentName: string,
  store: ScheduleStoreLike
): { output: string; exitCode: number } {
  const schedules = store.getSchedules(agentName);

  if (schedules.length === 0) {
    return {
      output: `No schedules found for agent '${agentName}'.`,
      exitCode: 0,
    };
  }

  const lines = [
    `${schedules.length} schedule${schedules.length === 1 ? "" : "s"} for agent '${agentName}':`,
    "",
  ];

  for (const s of schedules) {
    const status = s.enabled ? "✓" : "✗";
    const next = s.nextRun ? formatDate(s.nextRun) : "N/A";
    const shortId = s.id.slice(0, 8);
    lines.push(
      `  ${status} ${shortId}  ${s.cronExpression.padEnd(14)}  ${next}`
    );
    lines.push(`      "${s.message.slice(0, 60)}${s.message.length > 60 ? "..." : ""}"`);
  }

  lines.push("");
  lines.push("Use 'schedule show <id>' for details, 'schedule delete <id>' to remove.");

  return { output: lines.join("\n"), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: show
// ---------------------------------------------------------------------------

function handleShow(
  agentName: string,
  store: ScheduleStoreLike,
  parsed: ParsedArgs
): { output: string; exitCode: number } {
  if (!parsed.scheduleId) {
    return {
      output: ["Error: Schedule ID required.", "", "Usage: schedule show <id>"].join("\n"),
      exitCode: 1,
    };
  }

  // Try to find by partial ID
  const allSchedules = store.getSchedules(agentName);
  const schedule = allSchedules.find(
    (s) => s.id === parsed.scheduleId || s.id.startsWith(parsed.scheduleId!)
  );

  if (!schedule) {
    return {
      output: `Error: Schedule '${parsed.scheduleId}' not found.`,
      exitCode: 1,
    };
  }

  // Calculate next few runs
  const nextRuns = getNextRuns(schedule.cronExpression, 5);

  const lines = [
    `Schedule: ${schedule.id}`,
    "",
    `  Status: ${schedule.enabled ? "Enabled" : "Disabled"}`,
    `  Cron: ${schedule.cronExpression}`,
    `  Message: ${schedule.message}`,
    `  Created: ${formatDate(schedule.createdAt)}`,
    `  Run count: ${schedule.runCount}`,
    schedule.lastRun ? `  Last run: ${formatDate(schedule.lastRun)}` : null,
    "",
    "Upcoming runs:",
    ...nextRuns.map((d) => `  ${formatDate(d.toISOString())}`),
    "",
    "Commands:",
    `  schedule disable ${schedule.id.slice(0, 8)}`,
    `  schedule delete ${schedule.id.slice(0, 8)}`,
  ].filter(Boolean);

  return { output: lines.join("\n"), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: delete
// ---------------------------------------------------------------------------

function handleDelete(
  agentName: string,
  store: ScheduleStoreLike,
  parsed: ParsedArgs
): { output: string; exitCode: number } {
  if (!parsed.scheduleId) {
    return {
      output: ["Error: Schedule ID required.", "", "Usage: schedule delete <id>"].join("\n"),
      exitCode: 1,
    };
  }

  // Find schedule to verify ownership
  const allSchedules = store.getSchedules(agentName);
  const schedule = allSchedules.find(
    (s) => s.id === parsed.scheduleId || s.id.startsWith(parsed.scheduleId!)
  );

  if (!schedule) {
    return {
      output: `Error: Schedule '${parsed.scheduleId}' not found.`,
      exitCode: 1,
    };
  }

  const deleted = store.deleteSchedule(schedule.id);
  if (deleted) {
    return {
      output: `Schedule ${schedule.id.slice(0, 8)} deleted successfully.`,
      exitCode: 0,
    };
  } else {
    return {
      output: `Error: Failed to delete schedule '${parsed.scheduleId}'.`,
      exitCode: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Subcommand: enable/disable
// ---------------------------------------------------------------------------

function handleToggle(
  agentName: string,
  store: ScheduleStoreLike,
  parsed: ParsedArgs,
  enable: boolean
): { output: string; exitCode: number } {
  if (!parsed.scheduleId) {
    return {
      output: [
        "Error: Schedule ID required.",
        "",
        `Usage: schedule ${enable ? "enable" : "disable"} <id>`,
      ].join("\n"),
      exitCode: 1,
    };
  }

  // Find schedule to verify ownership
  const allSchedules = store.getSchedules(agentName);
  const schedule = allSchedules.find(
    (s) => s.id === parsed.scheduleId || s.id.startsWith(parsed.scheduleId!)
  );

  if (!schedule) {
    return {
      output: `Error: Schedule '${parsed.scheduleId}' not found.`,
      exitCode: 1,
    };
  }

  if (schedule.enabled === enable) {
    return {
      output: `Schedule ${schedule.id.slice(0, 8)} is already ${enable ? "enabled" : "disabled"}.`,
      exitCode: 0,
    };
  }

  const updated = store.updateSchedule(schedule.id, { enabled: enable });
  if (updated) {
    return {
      output: `Schedule ${schedule.id.slice(0, 8)} ${enable ? "enabled" : "disabled"}.`,
      exitCode: 0,
    };
  } else {
    return {
      output: `Error: Failed to update schedule '${parsed.scheduleId}'.`,
      exitCode: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Subcommand: test
// ---------------------------------------------------------------------------

function handleTest(parsed: ParsedArgs): { output: string; exitCode: number } {
  if (!parsed.testExpression) {
    return {
      output: ["Error: Cron expression required.", "", "Usage: schedule test <cron-expression>"].join("\n"),
      exitCode: 1,
    };
  }

  // Validate expression
  const validation = isValidCron(parsed.testExpression);
  if (!validation.valid) {
    return {
      output: `Error: Invalid cron expression: ${validation.error}`,
      exitCode: 1,
    };
  }

  // Get next runs
  const nextRuns = getNextRuns(parsed.testExpression, 5);

  const lines = [
    `Cron expression: ${parsed.testExpression}`,
    "",
    "Next 5 runs:",
    ...nextRuns.map((d, i) => `  ${i + 1}. ${formatDate(d.toISOString())}`),
    "",
    "Format: minute hour day-of-month month day-of-week",
    "Example: '0 9 * * 1-5' = 9:00 AM on weekdays",
  ];

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

// ---------------------------------------------------------------------------
// In-memory schedule store (used when no real store is injected)
// ---------------------------------------------------------------------------

class MemoryScheduleStore implements ScheduleStoreLike {
  private schedules = new Map<string, Schedule>();

  getSchedules(agentName: string): Schedule[] {
    return Array.from(this.schedules.values()).filter(
      (s) => s.agentName === agentName
    );
  }

  getAllSchedules(): Schedule[] {
    return Array.from(this.schedules.values());
  }

  getSchedule(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  saveSchedule(schedule: Schedule): void {
    this.schedules.set(schedule.id, schedule);
  }

  deleteSchedule(id: string): boolean {
    return this.schedules.delete(id);
  }

  updateSchedule(id: string, updates: Partial<Schedule>): boolean {
    const existing = this.schedules.get(id);
    if (!existing) return false;
    this.schedules.set(id, { ...existing, ...updates });
    return true;
  }
}

// ---------------------------------------------------------------------------
// createHandler — entry point called by the beige gateway at startup
// ---------------------------------------------------------------------------

export function createHandler(
  config: Record<string, unknown> = {},
  context: ScheduleContext = {}
): ToolHandler {
  // Use injected store or fall back to memory store (for testing)
  const store = context.scheduleStore ?? new MemoryScheduleStore();

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: IncomingSessionContext
  ): Promise<{ output: string; exitCode: number }> => {
    // ── Identify calling agent ─────────────────────────────────────────────
    const callerSessionKey = sessionContext?.sessionKey ?? "unknown";
    const callerAgent = sessionContext?.agentName ?? "unknown";

    if (callerAgent === "unknown") {
      return {
        output: [
          "Error: agent identity unknown.",
          "This tool requires BEIGE_AGENT_NAME to be set in the sandbox environment.",
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
      case "create":
        return handleCreate(callerAgent, callerSessionKey, store, parsed, config);

      case "list":
        return handleList(callerAgent, store);

      case "show":
        return handleShow(callerAgent, store, parsed);

      case "delete":
        return handleDelete(callerAgent, store, parsed);

      case "enable":
        return handleToggle(callerAgent, store, parsed, true);

      case "disable":
        return handleToggle(callerAgent, store, parsed, false);

      case "test":
        return handleTest(parsed);

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

// ---------------------------------------------------------------------------
// Exports for gateway scheduler service
// ---------------------------------------------------------------------------

export { ScheduleStoreLike, Schedule, isValidCron, getNextRuns };
