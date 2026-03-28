/**
 * wrangler tool
 *
 * Wraps the Cloudflare Wrangler CLI for managing Workers, D1, KV, R2, and more.
 *
 * ── Command paths ────────────────────────────────────────────────────────────
 *
 * A "command path" is ALL leading non-flag tokens of the args (unlimited depth):
 *
 *   ["d1", "database", "create", "mydb", "--remote"] → "d1 database create"
 *   ["kv", "namespace", "list"]                       → "kv namespace list"
 *   ["deploy", "--env", "production"]                 → "deploy"
 *   ["pages", "deploy", "./dist"]                     → "pages deploy"
 *
 * Permission entries are matched by prefix, so "d1" in denyCommands blocks ALL
 * d1 subcommands, while "d1 database destroy" blocks only that specific command.
 *
 * ── Permission model ─────────────────────────────────────────────────────────
 *
 *   1. denyCommands checked first — any prefix match → rejected.
 *   2. allowCommands checked second — if set and no prefix match → rejected.
 *   3. Both absent → command is permitted (no default denylist).
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 *
 * The apiToken and accountId from config are injected as environment variables:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID (if accountId is set)
 *
 * Config values can use ${ENV_VAR} syntax for injection by the config system.
 *
 * ── Binary resolution ────────────────────────────────────────────────────────
 *
 *   1. wranglerPath from config (if set)
 *   2. node_modules/.bin/wrangler (local project install)
 *   3. global "wrangler" on PATH
 *   4. ENOENT error if not found
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 *
 * createHandler accepts an optional second argument for testing:
 *   { executor?, resolveWranglerPath? }
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { resolveBin } from "../_shared/resolve-bin.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WranglerConfig {
  /**
   * Cloudflare API token. Required. Injected as CLOUDFLARE_API_TOKEN.
   * Can use ${ENV_VAR} for injection by the config system.
   */
  apiToken: string;

  /**
   * Cloudflare account ID. Optional. Injected as CLOUDFLARE_ACCOUNT_ID.
   * Can use ${ENV_VAR} for injection by the config system.
   */
  accountId?: string;

  /**
   * If set, only these command paths are permitted.
   * A command path is all subcommand tokens before any flags.
   * Prefix matching: "d1" covers all d1 subcommands.
   * Omit to allow all commands (subject to denyCommands).
   */
  allowCommands?: string | string[];

  /**
   * These command paths are always blocked, even if in allowCommands.
   * Deny beats allow. Prefix matching applies.
   */
  denyCommands?: string | string[];

  /**
   * Timeout in seconds for each wrangler invocation. Default: 180.
   */
  timeout?: number;

  /**
   * Override path to wrangler binary. If not set, auto-detects.
   */
  wranglerPath?: string;
}

/** Result returned by the executor (real or stub). */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Executor interface — injectable for testing. */
export type Executor = (
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  cwd?: string
) => Promise<ExecResult>;

/** Path resolver — injectable for testing. */
export type PathResolver = () => string | null;

/** Context injected by tests. */
export interface WranglerContext {
  executor?: Executor;
  resolveWranglerPath?: PathResolver;
}

type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: SessionContext
) => Promise<{ output: string; exitCode: number }>;

interface SessionContext {
  sessionKey?: string;
  channel?: string;
  agentName?: string;
  agentDir?: string;
  workspaceDir?: string;
  /**
   * Relative working directory from workspace root (e.g. "repos/myproject").
   * Populated by the tool-client from the container's cwd when the agent
   * invokes wrangler from a subdirectory of /workspace (e.g. via cd+exec).
   */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Command path extraction (unlimited depth)
// ---------------------------------------------------------------------------

/**
 * Extract the command path from raw args.
 *
 * Consumes ALL leading non-flag tokens (unlimited depth).
 * Stops at the first flag or "--".
 *
 * Examples:
 *   ["d1", "database", "create", "mydb", "--remote"] → "d1 database create"
 *   ["kv", "namespace", "list"]                       → "kv namespace list"
 *   ["deploy", "--env", "production"]                 → "deploy"
 *   ["--help"]                                        → ""
 *   []                                                → ""
 */
export function extractCommandPath(args: string[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg === "--" || arg.startsWith("-")) break;
    parts.push(arg);
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
 * Matching is by prefix: pattern "d1" matches "d1 database create",
 * "d1 database destroy", etc. Pattern "d1 database destroy" only matches exactly.
 */
function matchesAny(commandPath: string, patterns: string[]): boolean {
  const lower = commandPath.toLowerCase();
  return patterns.some((p) => {
    if (lower === p) return true;
    if (lower.startsWith(p + " ")) return true;
    return false;
  });
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a command path is permitted under the given config.
 *
 * @param commandPath  The extracted command path, e.g. "d1 database create".
 * @param config       The tool config.
 */
export function checkPermission(
  commandPath: string,
  config: WranglerConfig
): PermissionResult {
  const denyList = toPathArray(config.denyCommands);
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
// Wrangler binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the wrangler binary.
 *
 * Priority:
 *   1. config.wranglerPath (if set)
 *   2. node_modules/.bin/wrangler (relative to cwd)
 *   3. global "wrangler" on PATH
 *
 * Returns null if not found.
 */
export function resolveWranglerPath(configuredPath?: string): string | null {
  // 1. Configured path
  if (configuredPath) {
    if (existsSync(configuredPath)) {
      return configuredPath;
    }
    // If configured but not found, return null (will error)
    return null;
  }

  // 2. Local node_modules/.bin/wrangler
  const localPath = join(process.cwd(), "node_modules", ".bin", "wrangler");
  if (existsSync(localPath)) {
    return localPath;
  }

  // 3. Global wrangler — auto-resolve via which / common paths
  return resolveBin("wrangler");
}

// ---------------------------------------------------------------------------
// Real executor
// ---------------------------------------------------------------------------

function realExecutor(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  cwd?: string
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, ...env }, cwd }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          stdout: "",
          stderr: `wrangler not found. Install it with: npm install wrangler --save-dev\nOr globally: npm install -g wrangler`,
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
    "Usage: wrangler <command> [subcommand...] [args...]",
    "",
    "Examples:",
    "  wrangler deploy",
    "  wrangler dev --port 8787",
    "  wrangler tail --format json",
    "  wrangler d1 database list",
    "  wrangler d1 database create mydb",
    "  wrangler kv namespace list",
    "  wrangler kv key list --namespace-id <id>",
    "  wrangler r2 bucket list",
    "  wrangler pages deploy ./dist",
    "",
    "Run 'wrangler --help' for full command list.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// createHandler — entry point called by the beige gateway at startup
// ---------------------------------------------------------------------------

/**
 * @param rawConfig  Tool config from config.json5.
 * @param context    Injectable context (executor, resolveWranglerPath) for testing.
 */
export function createHandler(
  rawConfig: Record<string, unknown>,
  context: WranglerContext = {}
): ToolHandler {
  const config = rawConfig as unknown as WranglerConfig;
  const timeoutMs = (config.timeout ?? 180) * 1000;
  const executor: Executor = context.executor ?? realExecutor;
  const pathResolver: PathResolver = context.resolveWranglerPath ?? (() => resolveWranglerPath(config.wranglerPath));

  // Validate required config
  if (!config.apiToken) {
    return async () => ({
      output: "Configuration error: apiToken is required in wrangler tool config.",
      exitCode: 1,
    });
  }

  return async (args: string[], _config?: Record<string, unknown>, sessionContext?: SessionContext): Promise<{ output: string; exitCode: number }> => {
    // ── No args ───────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Extract command path and check permissions ─────────────────────────
    const commandPath = extractCommandPath(args);

    if (commandPath) {
      const perm = checkPermission(commandPath, config);
      if (!perm.allowed) {
        return {
          output: `Permission denied: ${perm.reason}`,
          exitCode: 1,
        };
      }
    } else {
      // Only flags provided (e.g. ["--help"]) — let wrangler handle it
    }

    // ── Resolve wrangler binary ───────────────────────────────────────────
    const wranglerPath = pathResolver();
    if (!wranglerPath) {
      return {
        output: "wrangler not found. Install it with: npm install wrangler --save-dev",
        exitCode: 127,
      };
    }

    // ── Build env with auth ───────────────────────────────────────────────
    const env: Record<string, string> = {
      CLOUDFLARE_API_TOKEN: config.apiToken,
    };
    if (config.accountId) {
      env.CLOUDFLARE_ACCOUNT_ID = config.accountId;
    }

    // ── Resolve working directory ────────────────────────────────────────
    // If the agent invoked wrangler from a subdirectory of /workspace (e.g.
    // via `cd /workspace/myproject && wrangler deploy`), the tool-client
    // captures the container's cwd as a relative path and the gateway puts
    // it in sessionContext.cwd. We join it with workspaceDir so that
    // wrangler runs in the correct subdirectory on the host.
    const workspaceRoot = sessionContext?.workspaceDir ?? process.cwd();
    const cwd = sessionContext?.cwd
      ? join(workspaceRoot, sessionContext.cwd)
      : workspaceRoot;

    // ── Execute ───────────────────────────────────────────────────────────
    const result = await executor(wranglerPath, args, env, timeoutMs, cwd);

    // Combine stdout and stderr
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
