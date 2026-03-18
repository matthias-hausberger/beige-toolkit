/**
 * confluence tool
 *
 * Wraps the `confluence` binary (confluence-cli) installed on the gateway
 * host.  Assumes the host is already authenticated.  Agents pass confluence
 * arguments directly; the tool enforces a permission layer before spawning
 * the subprocess.
 *
 * ── Command paths ────────────────────────────────────────────────────────────
 *
 * A "command path" is the first non-flag token of the args (confluence-cli
 * uses single-level subcommands):
 *
 *   ["read", "123456789"]                  → "read"
 *   ["search", "my query"]                 → "search"
 *   ["create", "My Page", "SPACE"]         → "create"
 *   ["profile", "list"]                    → "profile"
 *
 * Note: "profile" is treated as a single token since multi-word subcommand
 * paths such as "profile list" or "profile use" are also supported when
 * placed in allow/deny lists.
 *
 * ── Permission model ─────────────────────────────────────────────────────────
 *
 *   1. denyCommands checked first — any prefix match → rejected.
 *   2. allowCommands checked second — if set and no prefix match → rejected.
 *   3. Both absent → command is permitted (default: all allowed).
 *
 * Unlike the slack tool, confluence-cli has no built-in destructive auth
 * commands that need special protection (authentication is done once at
 * setup time via `confluence init`).  Therefore the default denylist is
 * EMPTY — all commands pass through unless the user configures restrictions.
 *
 * ── Subprocess ───────────────────────────────────────────────────────────────
 *
 * confluence is invoked via execFile with a configurable timeout (default
 * 30s).  stdout and stderr are combined and returned as-is.  The exit code
 * is passed through.
 *
 * If `config.profile` is set and the args don't already include --profile,
 * it is prepended automatically (confluence expects --profile before the
 * subcommand).
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

export interface ConfluenceConfig {
  /**
   * If set, only these command paths are permitted.
   * A command path is the leading subcommand token(s) before any flags,
   * e.g. "read", "search", "create", "profile list".
   * Prefix matching: "create" covers "create-child" as well.
   * Omit to allow all commands (subject to denyCommands).
   */
  allowCommands?: string | string[];

  /**
   * These command paths are always blocked, even if in allowCommands.
   * Deny beats allow.  Prefix matching applies.
   * Defaults to [] (nothing blocked) when no config is provided.
   */
  denyCommands?: string | string[];

  /**
   * Timeout in seconds for each confluence invocation.  Default: 30.
   */
  timeout?: number;

  /**
   * Default profile name.  Prepended as --profile <value> when not already
   * present in the agent's args.
   */
  profile?: string;
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
export interface ConfluenceContext {
  executor?: Executor;
}

type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>
) => Promise<{ output: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Default denylist
// ---------------------------------------------------------------------------

/**
 * confluence-cli does not have session-mutating auth subcommands that agents
 * should be shielded from (login happens once via `confluence init` at setup
 * time).  The default denylist is therefore empty — all commands pass through
 * unless the operator explicitly configures restrictions.
 */
const DEFAULT_DENY: string[] = [];

// ---------------------------------------------------------------------------
// Command path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the command path from raw confluence args.
 *
 * confluence-cli has a mostly flat subcommand structure with one exception:
 * the `profile` command takes a second token (`list`, `use`, `add`, `remove`).
 * All other subcommands are single tokens followed immediately by positional
 * arguments (page IDs, queries, space keys — none of which are subcommands).
 *
 * The global `--profile <name>` flag may appear before the subcommand;
 * we skip it (and its value) so permission checks see the real command.
 *
 * Rules:
 *   1. Skip leading `--profile <value>` if present.
 *   2. Capture the first non-flag token (the subcommand).
 *   3. If the subcommand is "profile", capture one more non-flag token.
 *   4. Stop — all further tokens are positional args, not subcommands.
 *
 * Examples:
 *   ["read", "123456789"]                        → "read"
 *   ["search", "my term", "--limit", "5"]         → "search"
 *   ["profile", "list"]                           → "profile list"
 *   ["profile", "use", "staging"]                 → "profile use"
 *   ["profile", "add", "staging", "--domain", "x"]→ "profile add"
 *   ["--profile", "staging", "read", "123"]       → "read"
 *   ["create-child", "My Page", "123456"]         → "create-child"
 *   ["--help"]                                    → ""
 *   []                                            → ""
 */
export function extractCommandPath(args: string[]): string {
  let i = 0;

  // Step 1: skip leading --profile <value>
  if (i < args.length && args[i] === "--profile") {
    i += 2; // skip flag + value
  }

  // Step 2: capture first non-flag token (the subcommand)
  if (i >= args.length || args[i] === "--" || args[i].startsWith("-")) {
    return "";
  }
  const subcommand = args[i];
  i++;

  // Step 3: if subcommand is "profile", capture one more non-flag token
  if (subcommand === "profile") {
    if (i < args.length && args[i] !== "--" && !args[i].startsWith("-")) {
      return `profile ${args[i]}`;
    }
    return "profile";
  }

  return subcommand;
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
 * Matching is by prefix: pattern "create" matches "create", "create-child",
 * etc.  Pattern "profile list" only matches "profile list".
 */
function matchesAny(commandPath: string, patterns: string[]): boolean {
  const lower = commandPath.toLowerCase();
  return patterns.some((p) => lower === p || lower.startsWith(p + " ") || lower.startsWith(p + "-"));
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a command path is permitted under the given config.
 *
 * @param commandPath  The extracted command path, e.g. "create" or "profile list".
 * @param config       The tool config (may be empty object if not configured).
 * @param hasConfig    Whether the user explicitly provided any config.
 *                     When false, the built-in DEFAULT_DENY is applied (empty
 *                     for confluence — all commands allowed by default).
 */
export function checkPermission(
  commandPath: string,
  config: ConfluenceConfig,
  hasConfig: boolean
): PermissionResult {
  const denyList = hasConfig ? toPathArray(config.denyCommands) : DEFAULT_DENY;
  const allowList = toPathArray(config.allowCommands);

  // 1. Deny check
  if (matchesAny(commandPath, denyList)) {
    const matched = denyList.find((p) => {
      const lower = commandPath.toLowerCase();
      return lower === p || lower.startsWith(p + " ") || lower.startsWith(p + "-");
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
          stderr: `confluence not found on PATH. Install it with: brew install pchuri/tap/confluence-cli  or  npm install -g confluence-cli`,
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
    "Usage: confluence <subcommand> [args...]",
    "",
    "Read / search:",
    "  confluence read <pageId|url> [--format text|html|markdown]",
    "  confluence info <pageId|url>",
    "  confluence search <query> [--limit <n>]",
    "  confluence spaces",
    "  confluence find <title> [--space <key>]",
    "  confluence children <pageId> [--recursive] [--format list|tree|json]",
    "",
    "Create / update / delete:",
    "  confluence create <title> <spaceKey> [--content <text>] [--file <path>] [--format markdown|html|storage]",
    "  confluence create-child <title> <parentId> [--content <text>] [--file <path>]",
    "  confluence update <pageId> [--title <t>] [--content <text>] [--file <path>]",
    "  confluence move <pageId|url> <newParentId|url> [--title <t>]",
    "  confluence delete <pageId|url> [--yes]",
    "  confluence copy-tree <sourceId> <targetParentId> [newTitle] [--dry-run]",
    "",
    "Attachments:",
    "  confluence attachments <pageId|url> [--pattern <glob>] [--download] [--dest <dir>]",
    "  confluence attachment-upload <pageId|url> --file <path> [--replace]",
    "  confluence attachment-delete <pageId|url> <attachmentId> [--yes]",
    "",
    "Comments:",
    "  confluence comments <pageId|url> [--format text|markdown|json]",
    "  confluence comment <pageId|url> --content <text>",
    "  confluence comment-delete <commentId> [--yes]",
    "",
    "Properties:",
    "  confluence property-list <pageId|url>",
    "  confluence property-get <pageId|url> <key>",
    "  confluence property-set <pageId|url> <key> --value <json>",
    "  confluence property-delete <pageId|url> <key> [--yes]",
    "",
    "Export / edit:",
    "  confluence export <pageId|url> [--format markdown|html|text] [--dest <dir>]",
    "  confluence edit <pageId> [--output <file>]",
    "",
    "Profiles:",
    "  confluence profile list",
    "  confluence profile use <name>",
    "  confluence profile add <name> [--domain <d>] [--token <t>]",
    "  confluence profile remove <name>",
    "",
    "  confluence stats",
    "",
    "Run 'confluence <subcommand> --help' for subcommand-specific options.",
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
  context: ConfluenceContext = {}
): ToolHandler {
  const hasConfig =
    rawConfig.allowCommands !== undefined ||
    rawConfig.denyCommands !== undefined ||
    rawConfig.timeout !== undefined ||
    rawConfig.profile !== undefined;

  const config: ConfluenceConfig = hasConfig ? (rawConfig as ConfluenceConfig) : {};
  const timeoutMs = (config.timeout ?? 30) * 1000;
  const defaultProfile = config.profile;
  const executor: Executor = context.executor ?? realExecutor;

  return async (args: string[]): Promise<{ output: string; exitCode: number }> => {
    // ── No args ───────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Extract command path and check permissions ─────────────────────────
    const commandPath = extractCommandPath(args);

    if (commandPath) {
      const perm = checkPermission(commandPath, config, hasConfig);
      if (!perm.allowed) {
        return {
          output: `Permission denied: ${perm.reason}`,
          exitCode: 1,
        };
      }
    }
    // If commandPath is empty (e.g. only flags like --help), let confluence handle it.

    // ── Inject default profile if configured and not already in args ───────
    let finalArgs = [...args];
    if (defaultProfile && !finalArgs.includes("--profile")) {
      // --profile must come before the subcommand
      finalArgs = ["--profile", defaultProfile, ...finalArgs];
    }

    // ── Execute ───────────────────────────────────────────────────────────
    const result = await executor("confluence", finalArgs, timeoutMs);

    const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");

    return {
      output: output || "(no output)",
      exitCode: result.exitCode,
    };
  };
}
