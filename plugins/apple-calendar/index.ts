/**
 * calendar tool
 *
 * Wraps a compiled Swift CLI (`calendar-cli`) that reads macOS Calendar data
 * via EventKit.  The CLI outputs JSON; the handler parses and validates the
 * args, enforces permission, spawns the binary, and returns structured output.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 * The Swift binary reads directly from the EventKit store — it does NOT launch
 * Calendar.app and is fast (~0.1–0.5s per query).  It supports all calendar
 * sources configured in macOS: iCloud, Google, Exchange, CalDAV, subscribed
 * calendars, birthdays, etc.
 *
 * On first invocation, if no compiled binary is found at the expected path,
 * the handler compiles it from the bundled Swift source.  This requires
 * `swiftc` on PATH (ships with Xcode / Xcode Command Line Tools).
 *
 * ── Permission model ──────────────────────────────────────────────────────────
 *
 * Command paths are the leading non-flag tokens (capped at 2):
 *
 *   ["events", "today"]                  → "events today"
 *   ["events", "search", "standup", ...] → "events search"
 *   ["calendars"]                        → "calendars"
 *
 * Config fields (both optional):
 *   allowedCommands  — whitelist; prefix matching
 *   deniedCommands   — blacklist; prefix matching; deny beats allow
 *
 * ── Dependency injection ──────────────────────────────────────────────────────
 *
 * createHandler accepts an optional context with an executor stub for testing.
 * Tests inject a fake that returns controlled output without spawning a process.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarConfig {
  /** Path to the compiled calendar-cli binary. */
  binaryPath?: string;
  /** Timeout in seconds per invocation. Default: 10. */
  timeout?: number;
  /** Allowed command paths (prefix matching). Omit to allow all. */
  allowedCommands?: string | string[];
  /** Denied command paths (prefix matching). Deny beats allow. */
  deniedCommands?: string | string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Executor interface — injectable for testing. */
export type Executor = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => Promise<ExecResult>;

/** Context injected by tests. */
export interface CalendarContext {
  executor?: Executor;
}

type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>
) => Promise<{ output: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Command path extraction (same pattern as slack tool)
// ---------------------------------------------------------------------------

/**
 * Extract the command path from raw args.
 *
 * Consumes leading non-flag tokens up to a maximum of 2.
 * Stops at the first flag or "--".
 *
 * Examples:
 *   ["events", "today"]                    → "events today"
 *   ["events", "search", "standup", ...]   → "events search"
 *   ["calendars"]                          → "calendars"
 *   ["--help"]                             → ""
 *   []                                     → ""
 */
export function extractCommandPath(args: string[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg === "--" || arg.startsWith("-")) break;
    parts.push(arg);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

function toPathArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function matchesAny(commandPath: string, patterns: string[]): boolean {
  const lower = commandPath.toLowerCase();
  return patterns.some((p) => lower === p || lower.startsWith(p + " "));
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a command path is permitted.
 */
export function checkPermission(
  commandPath: string,
  config: CalendarConfig
): PermissionResult {
  const denyList = toPathArray(config.deniedCommands);
  const allowList = toPathArray(config.allowedCommands);

  // 1. Deny check
  if (matchesAny(commandPath, denyList)) {
    const matched = denyList.find((p) => {
      const lower = commandPath.toLowerCase();
      return lower === p || lower.startsWith(p + " ");
    })!;
    return {
      allowed: false,
      reason: `command '${commandPath}' is blocked by deniedCommands ('${matched}')`,
    };
  }

  // 2. Allow check (only if allowList is non-empty)
  if (allowList.length > 0 && !matchesAny(commandPath, allowList)) {
    const permitted = allowList.join(", ");
    return {
      allowed: false,
      reason: `command '${commandPath}' is not in allowedCommands.\nPermitted commands: ${permitted}`,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Binary resolution & compilation
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the calendar-cli binary.
 *
 * Priority:
 *   1. config.binaryPath (explicit override)
 *   2. ./calendar-cli next to this index.ts file
 *
 * If the binary doesn't exist at the resolved path, attempt to compile it
 * from the bundled Swift source.
 */
function resolveBinaryPath(config: CalendarConfig): string {
  if (config.binaryPath) return config.binaryPath;

  // __dirname equivalent for ESM
  const thisDir = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

  return resolve(thisDir, "calendar-cli");
}

function compileBinary(binaryPath: string): Promise<void> {
  const sourceDir = dirname(binaryPath);
  const sourcePath = resolve(sourceDir, "calendar-cli.swift");

  if (!existsSync(sourcePath)) {
    return Promise.reject(
      new Error(
        `Swift source not found at ${sourcePath}. Cannot compile calendar-cli.`
      )
    );
  }

  return new Promise((resolve, reject) => {
    execFile(
      "swiftc",
      [sourcePath, "-o", binaryPath, "-O"],
      { timeout: 120_000 },
      (err) => {
        if (err) {
          reject(
            new Error(
              `Failed to compile calendar-cli: ${err.message}. ` +
                `Ensure Xcode Command Line Tools are installed (xcode-select --install).`
            )
          );
        } else {
          resolve();
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Real executor
// ---------------------------------------------------------------------------

function realExecutor(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          stdout: "",
          stderr: `calendar-cli binary not found at '${cmd}'. Try recompiling or set config.binaryPath.`,
          exitCode: 127,
        });
        return;
      }
      const exitCode =
        err && typeof (err as any).code === "number"
          ? (err as any).code
          : err
            ? 1
            : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
    });
  });
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function usageText(): string {
  return [
    "Usage: apple-calendar <subcommand> [args...]",
    "",
    "Commands:",
    "  apple-calendar calendars                                         — List all calendars",
    "  apple-calendar events today                                      — Events occurring today",
    "  apple-calendar events tomorrow                                   — Events occurring tomorrow",
    "  apple-calendar events date <yyyy-MM-dd>                          — Events on a specific date",
    "  apple-calendar events range <yyyy-MM-dd> <yyyy-MM-dd>            — Events in a date range (inclusive)",
    "  apple-calendar events search <query> [--from <date>] [--to <date>] — Search events by title/notes/location",
    "",
    "All output is JSON. Dates use yyyy-MM-dd format.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// createHandler — entry point called by the beige gateway at startup
// ---------------------------------------------------------------------------

/**
 * @param rawConfig  Tool config from config.json5, or empty object if absent.
 * @param context    Injectable context (executor) for testing.
 */
export function createHandler(
  rawConfig: Record<string, unknown>,
  context: CalendarContext = {}
): ToolHandler {
  const config = rawConfig as CalendarConfig;
  const timeoutMs = (config.timeout ?? 10) * 1000;
  const binaryPath = resolveBinaryPath(config);
  const executor: Executor = context.executor ?? realExecutor;

  // Track whether we've already compiled (or tried to compile)
  let compilePromise: Promise<void> | null = null;

  return async (args: string[]): Promise<{ output: string; exitCode: number }> => {
    // ── No args ───────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Extract command path and check permissions ────────────────────────
    const commandPath = extractCommandPath(args);

    if (commandPath) {
      const perm = checkPermission(commandPath, config);
      if (!perm.allowed) {
        return {
          output: `Permission denied: ${perm.reason}`,
          exitCode: 1,
        };
      }
    }

    // ── Ensure binary exists (compile on first use if needed) ─────────────
    if (!context.executor && !existsSync(binaryPath)) {
      if (!compilePromise) {
        compilePromise = compileBinary(binaryPath);
      }
      try {
        await compilePromise;
      } catch (err: any) {
        return {
          output: err.message ?? "Failed to compile calendar-cli.",
          exitCode: 1,
        };
      }
    }

    // ── Execute ───────────────────────────────────────────────────────────
    const result = await executor(binaryPath, args, timeoutMs);

    // calendar-cli writes JSON to stdout on success and JSON errors to stderr.
    // Combine non-empty streams.
    const output = [result.stdout, result.stderr]
      .filter((s) => s.trim())
      .join("\n");

    return {
      output: output || "(no output)",
      exitCode: result.exitCode,
    };
  };
}

// ── Plugin adapter ───────────────────────────────────────────────────────────
// Wraps the legacy createHandler as a plugin for the v2 plugin system.

import type {
  PluginInstance,
  PluginContext,
  PluginRegistrar,
} from "@matthias-hausberger/beige";
import { readFileSync } from "fs";
import { join as joinPath } from "path";

export function createPlugin(
  config: Record<string, unknown>,
  _ctx: PluginContext
): PluginInstance {
  const manifestPath = joinPath(import.meta.dirname!, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const handler = createHandler(config);

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
