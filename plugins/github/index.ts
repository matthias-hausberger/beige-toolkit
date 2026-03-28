import { spawn } from "child_process";
import { join } from "path";
import { resolveBin } from "../_shared/resolve-bin.ts";

// ---------------------------------------------------------------------------
// Types — self-contained, no beige source imports needed.
// ---------------------------------------------------------------------------

/**
 * Session context injected by the beige gateway.
 *
 * The gateway provides the actual host paths — the sandboxed agent only knows
 * about /workspace inside its container. This context allows the tool to
 * run gh from the correct directory on the gateway host.
 */
interface SessionContext {
  sessionKey?: string;
  channel?: string;
  agentName?: string;
  agentDir?: string;
  /** Absolute path on the gateway host to the agent's workspace. */
  workspaceDir?: string;
  /**
   * Relative working directory from workspace root (e.g. "repos/myrepo").
   * Populated by the tool-client from the container's cwd when the agent
   * invokes github from a subdirectory of /workspace (e.g. via cd+exec).
   */
  cwd?: string;
}

type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: SessionContext
) => Promise<{ output: string; exitCode: number }>;

export type GhExecutor = (
  args: string[],
  token: string | undefined,
  cwd: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Default set of top-level gh subcommands permitted when no allowedCommands
 * config is provided.
 *
 * Notably absent: "api" — raw API access (arbitrary HTTP methods + GraphQL
 * mutations) is considered elevated and must be explicitly opted into via
 * allowedCommands: ["api", ...] in the tool config.
 */
const ALL_COMMANDS = [
  "repo",
  "issue",
  "pr",
  "release",
  "run",
  "workflow",
  "gist",
  "org",
  "project",
  "search",
  "auth",
  "browse",
  "cache",
  "codespace",
  "secret",
  "variable",
  "label",
  "milestone",
  "ruleset",
  "attestation",
] as const;

/**
 * Resolve which top-level gh subcommands are permitted for this tool instance.
 *
 * Config fields (both optional, strings or arrays of strings):
 *   allowedCommands  — whitelist; only these subcommands are permitted.
 *                      Defaults to ALL_COMMANDS when absent. Set explicitly
 *                      to include "api" if raw API access is needed.
 *   deniedCommands   — blacklist; these subcommands are always blocked,
 *                      even if present in allowedCommands.
 *
 * Precedence: deny beats allow.
 */
function resolveAllowedCommands(config: Record<string, unknown>): Set<string> {
  const toArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") return [value];
    return [];
  };

  const allowed = new Set<string>(
    config.allowedCommands !== undefined
      ? toArray(config.allowedCommands)
      : ALL_COMMANDS
  );

  for (const cmd of toArray(config.deniedCommands)) {
    allowed.delete(cmd);
  }

  return allowed;
}

/**
 * Default executor: spawns the real gh CLI and returns its output.
 *
 * When a token is provided it is passed via the GH_TOKEN environment variable,
 * which gh (and the underlying git credential helper) recognises for both
 * classic personal access tokens (ghp_…) and fine-grained PATs (github_pat_…).
 * This overrides any token that may already be stored in ~/.config/gh/ so the
 * agent-specific token always takes precedence.
 *
 * When no token is provided the process environment is inherited as-is, so
 * existing gh auth (via `gh auth login`) continues to work.
 *
 * The cwd parameter sets the working directory for the gh subprocess. This is
 * critical for commands like `pr create` that read .git/config to discover the
 * repository. The cwd should be the agent's workspace directory on the gateway
 * host (sessionContext.workspaceDir).
 */
/**
 * Resolve the full path to the gh binary.
 *
 * Priority:
 *   1. Explicit binPath from config
 *   2. Auto-detect via resolveBin() (which → common paths → bare name)
 */
function resolveGhBin(config: Record<string, unknown>): string {
  if (typeof config.binPath === "string" && config.binPath.trim()) {
    return config.binPath.trim();
  }
  return resolveBin("gh");
}

export const createGhExecutor = (bin: string): GhExecutor => (args, token, cwd) =>
  new Promise((resolve) => {
    const env = token
      ? { ...process.env, GH_TOKEN: token }
      : process.env;

    const proc = spawn(bin, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: `Failed to spawn gh (${bin}): ${err.message}. Is the GitHub CLI installed on the gateway host? If gh is not on PATH, set binPath in the github tool config (e.g. binPath: "/opt/homebrew/bin/gh").`,
        exitCode: 1,
      });
    });
  });

/** Default executor using bare "gh" — for backward compatibility. */
export const defaultGhExecutor: GhExecutor = createGhExecutor("gh");

/**
 * GitHub Tool — Routes all commands to the gh CLI running on the gateway host.
 *
 * Authentication:
 *   - When `config.token` is set it is forwarded to gh via GH_TOKEN, taking
 *     precedence over any locally stored credential.  Both classic personal
 *     access tokens (ghp_…) and fine-grained PATs (github_pat_…) are accepted
 *     by gh without any special handling on our side.
 *   - When no token is configured, the tool falls back to whatever gh auth is
 *     already present on the host (~/.config/gh/, GITHUB_TOKEN, etc.).
 *
 * Access control: allowedCommands and deniedCommands restrict which top-level
 * gh subcommands an agent may invoke.
 *
 * The optional second argument accepts a GhExecutor for dependency injection
 * in tests. Production callers omit it and get the real gh CLI.
 */
export function createHandler(
  config: Record<string, unknown>,
  { executor = createGhExecutor(resolveGhBin(config)) }: { executor?: GhExecutor } = {}
): ToolHandler {
  const allowedCommands = resolveAllowedCommands(config);
  const token = typeof config.token === "string" && config.token.trim()
    ? config.token.trim()
    : undefined;

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: SessionContext
  ) => {
    // Resolve working directory — the workspace on the gateway host.
    // This is critical for commands like `pr create` that read .git/config
    // to discover the repository. Falls back to process.cwd() when not in
    // a session (e.g., tests).
    //
    // If the agent invoked github from a subdirectory of /workspace (e.g.
    // via `cd /workspace/myrepo && github pr create`), the tool-client
    // captures the container's cwd as a relative path ("myrepo") and the
    // gateway puts it in sessionContext.cwd. We join it with workspaceDir
    // so that gh runs in the correct subdirectory on the host — this is
    // essential for commands that need to operate within a git repository.
    const workspaceRoot = sessionContext?.workspaceDir ?? process.cwd();
    const cwd = sessionContext?.cwd
      ? join(workspaceRoot, sessionContext.cwd)
      : workspaceRoot;

    if (args.length === 0) {
      return {
        output: [
          "Usage: github <subcommand> [args...]",
          "",
          "Routes to the gh CLI on the gateway host. Examples:",
          "  github repo list",
          "  github issue list --repo owner/repo",
          "  github pr view 42 --repo owner/repo",
          "",
          `Permitted subcommands: ${[...allowedCommands].join(", ") || "(none)"}`,
        ].join("\n"),
        exitCode: 1,
      };
    }

    const [subcommand, ...rest] = args;

    // Access-control check — runs before any gh invocation.
    if (!allowedCommands.has(subcommand)) {
      const permitted = [...allowedCommands].join(", ") || "(none)";
      return {
        output: `Permission denied: subcommand '${subcommand}' is not allowed for this agent.\nPermitted subcommands: ${permitted}`,
        exitCode: 1,
      };
    }

    // Hard-blocked operations — these cannot be enabled by any config.
    if (subcommand === "repo" && rest[0] === "delete") {
      return {
        output: "Permission denied: 'repo delete' is permanently blocked. Repository deletion is not permitted through this tool.",
        exitCode: 1,
      };
    }

    const result = await executor([subcommand, ...rest], token, cwd);

    // On success return stdout. On failure include both streams so the agent
    // can diagnose the problem.
    if (result.exitCode === 0) {
      return {
        output: result.stdout || "(no output)",
        exitCode: 0,
      };
    }

    const parts = [result.stdout, result.stderr].filter((s) => s.trim());
    return {
      output: parts.join("\n") || `gh exited with code ${result.exitCode}`,
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
