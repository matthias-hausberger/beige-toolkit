/**
 * slack tool
 *
 * Wraps the `slackcli` binary installed on the gateway host.  Agents pass
 * slackcli arguments directly; the tool enforces a permission layer before
 * spawning the subprocess.
 *
 * ── Command paths ────────────────────────────────────────────────────────────
 *
 * A "command path" is the leading non-flag tokens of the args, capped at two
 * levels (matching slackcli's command depth):
 *
 *   ["conversations", "list", "--limit", "50"] → "conversations list"
 *   ["messages", "send", "--recipient-id", ...]→ "messages send"
 *   ["auth", "login"]                          → "auth login"
 *
 * Permission entries are matched by prefix, so "messages" in denyCommands
 * blocks ALL messages subcommands, while "messages send" blocks only send.
 *
 * ── Permission model ─────────────────────────────────────────────────────────
 *
 *   1. denyCommands checked first — any prefix match → rejected.
 *   2. allowCommands checked second — if set and no prefix match → rejected.
 *   3. Both absent → command is permitted (subject to default denylist).
 *
 * Default denylist (applied when no config is provided):
 *   auth login, auth login-browser, auth logout, auth remove,
 *   auth extract-tokens, auth parse-curl, update
 *
 * ── Subprocess ───────────────────────────────────────────────────────────────
 *
 * slackcli is invoked via execFile with a configurable timeout (default 30s).
 * stdout and stderr are combined and returned as-is.  The slackcli exit code
 * is passed through.
 *
 * If `config.workspace` is set and the args don't already include --workspace,
 * it is appended automatically.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 *
 * createHandler accepts an optional second argument for testing:
 *
 *   { executor? }
 *
 * executor replaces the real execFile call.  Tests inject a stub that returns
 * controlled output without spawning any process.
 */

import { execFile } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackConfig {
  /**
   * If set, only these command paths are permitted.
   * A command path is the leading 1-2 subcommand tokens, e.g. "messages send".
   * Prefix matching: "messages" covers all messages subcommands.
   * Omit to allow all commands (subject to denyCommands / default denylist).
   */
  allowCommands?: string | string[];

  /**
   * These command paths are always blocked, even if in allowCommands.
   * Deny beats allow.  Prefix matching applies.
   * When no config is provided at all, a built-in denylist is used.
   */
  denyCommands?: string | string[];

  /**
   * Timeout in seconds for each slackcli invocation.  Default: 30.
   */
  timeout?: number;

  /**
   * Default workspace ID or name.  Appended as --workspace <value> when
   * not already present in the agent's args.
   */
  workspace?: string;
}

/** Result returned by the executor (real or stub). */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Executor interface — injectable for testing. */
export type Executor = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/** Context injected by tests. */
export interface SlackContext {
  executor?: Executor;
}

type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>
) => Promise<{ output: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Default denylist — applied when the user provides NO config at all.
// These are auth-mutating and update operations that agents should never
// run autonomously.
// ---------------------------------------------------------------------------

const DEFAULT_DENY: string[] = [
  "auth login",
  "auth login-browser",
  "auth logout",
  "auth remove",
  "auth extract-tokens",
  "auth parse-curl",
  "update",
];

// ---------------------------------------------------------------------------
// Command path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the command path from raw args.
 *
 * Consumes leading non-flag tokens up to a maximum of 2 (matching slackcli's
 * depth).  Stops at the first flag or "--".
 *
 * Examples:
 *   ["conversations", "list", "--limit", "50"] → "conversations list"
 *   ["messages", "send", "--recipient-id", "C1"] → "messages send"
 *   ["auth", "list"] → "auth list"
 *   ["--help"] → ""
 *   [] → ""
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

/**
 * Normalise config field to an array of trimmed, lowercase command path strings.
 */
function toPathArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Return true if `commandPath` is matched by any entry in `patterns`.
 * Matching is by prefix: pattern "messages" matches "messages send",
 * "messages react", etc.  Pattern "messages send" only matches "messages send".
 */
function matchesAny(commandPath: string, patterns: string[]): boolean {
  const lower = commandPath.toLowerCase();
  return patterns.some((p) => lower === p || lower.startsWith(p + " "));
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a command path is permitted under the given config.
 *
 * @param commandPath  The extracted command path, e.g. "messages send".
 * @param config       The tool config (may be empty object if not configured).
 * @param hasConfig    Whether the user explicitly provided any config.
 *                     When false, the built-in DEFAULT_DENY is applied.
 */
export function checkPermission(
  commandPath: string,
  config: SlackConfig,
  hasConfig: boolean
): PermissionResult {
  const denyList = hasConfig ? toPathArray(config.denyCommands) : DEFAULT_DENY;
  const allowList = toPathArray(config.allowCommands);

  // 1. Deny check
  if (matchesAny(commandPath, denyList)) {
    const matched = denyList.find((p) => {
      const lower = commandPath.toLowerCase();
      return lower === p || lower.startsWith(p + " ");
    })!;
    return {
      allowed: false,
      reason: `command '${commandPath}' is blocked by denyCommands ('${matched}')`,
    };
  }

  // 2. Allow check (only if allowList is non-empty)
  if (allowList.length > 0 && !matchesAny(commandPath, allowList)) {
    const permitted = allowList.join(", ");
    return {
      allowed: false,
      reason: `command '${commandPath}' is not in allowCommands.\nPermitted commands: ${permitted}`,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Real executor
// ---------------------------------------------------------------------------

function realExecutor(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          stdout: "",
          stderr: `slackcli not found on PATH. Install it with: npm install -g slackcli`,
          exitCode: 127,
        });
        return;
      }
      // err may be set for non-zero exit codes — extract exitCode from it
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
    "Usage: slack <subcommand> [args...]",
    "",
    "Examples:",
    "  slack conversations list",
    "  slack conversations read <channel-id> --limit 50",
    "  slack messages send --recipient-id <id> --message \"Hello\"",
    "  slack messages react --channel-id <id> --timestamp <ts> --emoji thumbsup",
    "  slack messages draft --recipient-id <id> --message \"Draft text\"",
    "  slack auth list",
    "  slack auth set-default <workspace-id>",
    "",
    "Run 'slack <subcommand> --help' for subcommand-specific options.",
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
  context: SlackContext = {}
): ToolHandler {
  // Determine whether the user actually provided any config.
  // An empty object means "no config" → use DEFAULT_DENY.
  const hasConfig =
    rawConfig.allowCommands !== undefined ||
    rawConfig.denyCommands !== undefined ||
    rawConfig.timeout !== undefined ||
    rawConfig.workspace !== undefined;

  const config: SlackConfig = hasConfig ? (rawConfig as SlackConfig) : {};
  const timeoutMs = (config.timeout ?? 30) * 1000;
  const defaultWorkspace = config.workspace;
  const executor: Executor = context.executor ?? realExecutor;

  return async (args: string[]): Promise<{ output: string; exitCode: number }> => {
    // ── No args ───────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Extract command path and check permissions ─────────────────────────
    const commandPath = extractCommandPath(args);

    if (!commandPath) {
      // Only flags provided (e.g. ["--help"]) — let slackcli handle it
    } else {
      const perm = checkPermission(commandPath, config, hasConfig);
      if (!perm.allowed) {
        return {
          output: `Permission denied: ${perm.reason}`,
          exitCode: 1,
        };
      }
    }

    // ── Inject default workspace if configured and not already in args ─────
    let finalArgs = [...args];
    if (defaultWorkspace && !finalArgs.includes("--workspace")) {
      finalArgs = [...finalArgs, "--workspace", defaultWorkspace];
    }

    // ── Execute ───────────────────────────────────────────────────────────
    const result = await executor("slackcli", finalArgs, timeoutMs);

    // Combine stdout and stderr, matching the exec tool convention
    const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");

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
