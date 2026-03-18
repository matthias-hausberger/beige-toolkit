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
 *   ["profile", "list"]                    → "profile list"
 *
 * ── Command-level permission model ───────────────────────────────────────────
 *
 *   1. denyCommands checked first — any prefix match → rejected.
 *   2. allowCommands checked second — if set and no prefix match → rejected.
 *   3. Both absent → command is permitted (default: all allowed).
 *
 * Unlike the slack tool, confluence-cli has no built-in destructive auth
 * commands that need special protection (authentication is done once at
 * setup time via `confluence init`).  Therefore the default denylist is
 * EMPTY — all commands pass through unless the operator explicitly restricts.
 *
 * ── Space-level permission model ─────────────────────────────────────────────
 *
 * When `allowReadSpaces` and/or `allowWriteSpaces` are configured, a second
 * permission layer enforces which Confluence spaces the agent may access.
 * When neither is configured, this layer is skipped entirely.
 *
 * Commands are classified as READ or WRITE:
 *
 *   READ  : read, info, children, attachments, comments, property-list,
 *           property-get, export, edit, find, search
 *   WRITE : create, create-child, update, delete, move, copy-tree,
 *           attachment-upload, attachment-delete, comment,
 *           property-set, property-delete
 *   AGNOSTIC (no space enforcement): spaces, stats, profile, init,
 *           comment-delete (see disclaimer below)
 *
 * Space resolution strategy:
 *
 *   Tier 1 — static (free, no API call):
 *     `create`         : space key is positional args[2]
 *     `find --space`   : --space flag value
 *     `search --space` : --space flag value
 *     URL arguments    : parsed from /wiki/spaces/SPACEKEY/ in the path
 *
 *   Tier 2 — dynamic (requires one `confluence info <pageId>` call):
 *     All other commands whose target is a numeric page ID.
 *     Results are cached in-process for the lifetime of the handler.
 *
 * Enforcement order per call:
 *   1. Command-level allow/deny check
 *   2. Space-level check (if allowReadSpaces / allowWriteSpaces configured)
 *   3. Execute
 *
 * ⚠️  CQL disclaimer:
 *   The `search` command accepts a free-text query that may contain CQL
 *   expressions (e.g. `space IN (TEAM, DOCS) AND ...`).  This tool only
 *   inspects the `--space` flag; CQL embedded in the query string is NOT
 *   parsed or enforced.  If strict space isolation for search is required,
 *   set `requireSpaceOnSearch: true` (rejects searches without `--space`)
 *   AND combine with a denyCommands entry or network-level controls if you
 *   cannot trust agents to omit CQL.
 *
 * ⚠️  comment-delete disclaimer:
 *   `comment-delete <commentId>` takes a comment ID, not a page ID or URL.
 *   confluence-cli provides no way to look up a comment's parent page or
 *   space from a comment ID alone, so space enforcement is not applied to
 *   this command.  Restrict it via denyCommands if needed.
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
 * executor replaces every real execFile call, including the `confluence info`
 * lookups used for Tier 2 space resolution.  Tests inject a stub that returns
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
   * Spaces the agent is allowed to READ from.
   * Applies to: read, info, children, attachments, comments, property-list,
   * property-get, export, edit, find, search (with --space).
   *
   * Omit (or set to empty array) to allow reading from ALL spaces.
   *
   * Space keys are matched case-insensitively.
   *
   * ⚠️  CQL in `search` query strings is NOT enforced — see module disclaimer.
   */
  allowReadSpaces?: string | string[];

  /**
   * Spaces the agent is allowed to WRITE to.
   * Applies to: create, create-child, update, delete, move, copy-tree,
   * attachment-upload, attachment-delete, comment, property-set,
   * property-delete.
   *
   * Omit (or set to empty array) to allow writing to ALL spaces.
   *
   * Space keys are matched case-insensitively.
   *
   * ⚠️  comment-delete is NOT covered — see module disclaimer.
   */
  allowWriteSpaces?: string | string[];

  /**
   * When true, `search` calls that do not include a `--space` flag are
   * rejected.  Forces agents to always scope searches to a specific space.
   * Default: false.
   *
   * Note: this controls the --space flag only.  CQL in the query string is
   * not parsed.  See the CQL disclaimer in the module header.
   */
  requireSpaceOnSearch?: boolean;

  /**
   * Timeout in seconds for each confluence invocation.  Default: 30.
   * Also applied to the internal `confluence info` calls used for
   * Tier 2 space resolution.
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
// Command classification
// ---------------------------------------------------------------------------

/**
 * READ commands: the agent is reading Confluence content.
 * Space enforcement checks allowReadSpaces.
 */
const READ_COMMANDS = new Set([
  "read",
  "info",
  "children",
  "attachments",
  "comments",
  "property-list",
  "property-get",
  "export",
  "edit",
  "find",
  "search",
]);

/**
 * WRITE commands: the agent is mutating Confluence content.
 * Space enforcement checks allowWriteSpaces.
 */
const WRITE_COMMANDS = new Set([
  "create",
  "create-child",
  "update",
  "delete",
  "move",
  "copy-tree",
  "attachment-upload",
  "attachment-delete",
  "comment",
  "property-set",
  "property-delete",
]);

// AGNOSTIC (no space enforcement): spaces, stats, profile, init,
// comment-delete (see disclaimer).

export type CommandKind = "read" | "write" | "agnostic";

export function classifyCommand(subcommand: string): CommandKind {
  if (READ_COMMANDS.has(subcommand)) return "read";
  if (WRITE_COMMANDS.has(subcommand)) return "write";
  return "agnostic";
}

// ---------------------------------------------------------------------------
// Default denylist
// ---------------------------------------------------------------------------

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
// Space extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a Confluence space key from a URL.
 *
 * Confluence Cloud URLs contain the space key in the path:
 *   https://domain.atlassian.net/wiki/spaces/SPACEKEY/pages/...
 *
 * Returns the space key string (uppercased) or null if not found.
 */
export function extractSpaceFromUrl(urlOrId: string): string | null {
  // Match /wiki/spaces/<KEY>/ — key is alphanumeric + hyphens/underscores
  const m = urlOrId.match(/\/wiki\/spaces\/([A-Za-z0-9_~-]+)\//i);
  if (m) return m[1].toUpperCase();
  return null;
}

/**
 * Return the value of a named flag from an args array, or null.
 *
 * Handles both "--flag value" (two separate tokens) forms.
 */
export function extractFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

/**
 * Return true if the string looks like a numeric Confluence page ID
 * (all digits, no slashes or dots).
 */
export function isPageId(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Get the first positional argument after the subcommand (and after any
 * leading --profile flag).  This is args[1] in most commands, but we derive
 * it properly by skipping the global flag and the subcommand token itself.
 *
 * Returns null if there is no such token (or it looks like a flag).
 */
export function extractFirstPositional(args: string[]): string | null {
  let i = 0;
  if (i < args.length && args[i] === "--profile") i += 2;
  if (i >= args.length || args[i].startsWith("-")) return null;
  i++; // skip subcommand
  if (i >= args.length || args[i].startsWith("-")) return null;
  return args[i];
}

/**
 * Get the second positional argument after the subcommand.
 * Used for `create` (spaceKey), `create-child` (parentId),
 * `copy-tree` (targetParentId), `move` (newParentId).
 *
 * Returns null if there is no such token.
 */
export function extractSecondPositional(args: string[]): string | null {
  let i = 0;
  if (i < args.length && args[i] === "--profile") i += 2;
  if (i >= args.length || args[i].startsWith("-")) return null;
  i++; // skip subcommand
  if (i >= args.length || args[i].startsWith("-")) return null;
  i++; // skip first positional
  if (i >= args.length || args[i].startsWith("-")) return null;
  return args[i];
}

// ---------------------------------------------------------------------------
// Command-level permission check
// ---------------------------------------------------------------------------

function toStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((s) => s.trim()).filter(Boolean);
}

function toPathArray(value: string | string[] | undefined): string[] {
  return toStringArray(value).map((s) => s.toLowerCase());
}

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
// Space-level permission check
// ---------------------------------------------------------------------------

/**
 * Check whether the resolved space key is permitted for the given kind.
 *
 * Returns allowed:true when:
 *   - The relevant allowlist is empty / not configured (no restriction).
 *   - The space key matches an entry (case-insensitive).
 */
export function checkSpacePermission(
  spaceKey: string,
  kind: "read" | "write",
  config: ConfluenceConfig
): PermissionResult {
  const list = toStringArray(
    kind === "read" ? config.allowReadSpaces : config.allowWriteSpaces
  ).map((s) => s.toUpperCase());

  if (list.length === 0) return { allowed: true };

  const upper = spaceKey.toUpperCase();
  if (list.includes(upper)) return { allowed: true };

  return {
    allowed: false,
    reason: `space '${spaceKey}' is not in allow${kind === "read" ? "Read" : "Write"}Spaces.\nPermitted spaces: ${list.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Space resolution
// ---------------------------------------------------------------------------

/**
 * Parse the space key out of `confluence info` output.
 *
 * confluence-cli prints something like:
 *   Title: My Page
 *   Space: TEAM
 *   ...
 *
 * Returns the space key string or null if not found.
 */
export function parseSpaceFromInfoOutput(output: string): string | null {
  const m = output.match(/^Space:\s*([A-Za-z0-9_~-]+)/im);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Resolve the Confluence space key for a page ID or URL.
 *
 * Fast path (free): if the value is a URL containing /wiki/spaces/KEY/,
 * extract the space key directly without any API call.
 *
 * Slow path (Tier 2): if the value is a numeric page ID, call
 * `confluence info <pageId>` and parse the output.
 *
 * Results for page IDs are cached in the provided Map for the lifetime of
 * the handler, so repeated calls on the same page never make duplicate
 * API requests.
 *
 * Returns the space key (uppercased) or null if it cannot be determined.
 */
export async function resolveSpaceKey(
  pageIdOrUrl: string,
  executor: Executor,
  timeoutMs: number,
  cache: Map<string, string>,
  profileArgs: string[]
): Promise<string | null> {
  // Fast path: URL
  const fromUrl = extractSpaceFromUrl(pageIdOrUrl);
  if (fromUrl) return fromUrl;

  // Slow path: numeric page ID
  if (!isPageId(pageIdOrUrl)) return null;

  const cached = cache.get(pageIdOrUrl);
  if (cached !== undefined) return cached;

  // Invoke `confluence [--profile X] info <pageId>`
  const infoArgs = [...profileArgs, "info", pageIdOrUrl];
  const result = await executor("confluence", infoArgs, timeoutMs);
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const spaceKey = parseSpaceFromInfoOutput(combined);

  if (spaceKey) cache.set(pageIdOrUrl, spaceKey);
  return spaceKey;
}

// ---------------------------------------------------------------------------
// Space enforcement entry point
// ---------------------------------------------------------------------------

/**
 * Determine the target space(s) for the given command and args, then check
 * them against the configured allowReadSpaces / allowWriteSpaces.
 *
 * Returns allowed:true when:
 *   - Neither allowReadSpaces nor allowWriteSpaces is configured (no-op).
 *   - The command is space-agnostic (spaces, stats, profile, comment-delete…).
 *   - The space key could not be resolved (we fail open to avoid false blocks
 *     on commands that have no extractable target, e.g. bare `spaces`).
 *   - The resolved space key is in the relevant list.
 *
 * Returns allowed:false with a reason when the space is not permitted.
 */
export async function enforceSpacePolicy(
  subcommand: string,
  args: string[],
  config: ConfluenceConfig,
  executor: Executor,
  timeoutMs: number,
  cache: Map<string, string>,
  profileArgs: string[]
): Promise<PermissionResult> {
  const readSpaces = toStringArray(config.allowReadSpaces);
  const writeSpaces = toStringArray(config.allowWriteSpaces);

  // No space restrictions configured at all → skip entirely
  if (readSpaces.length === 0 && writeSpaces.length === 0) {
    return { allowed: true };
  }

  const kind = classifyCommand(subcommand);

  // Space-agnostic commands (spaces, stats, profile, init, comment-delete)
  if (kind === "agnostic") return { allowed: true };

  // ── requireSpaceOnSearch ─────────────────────────────────────────────────
  if (subcommand === "search") {
    const spaceFlag = extractFlag(args, "--space");
    if (!spaceFlag) {
      if (config.requireSpaceOnSearch) {
        return {
          allowed: false,
          reason:
            "search without --space is not permitted (requireSpaceOnSearch is enabled).\n" +
            "Add --space <KEY> to scope the search to a specific space.\n" +
            "Note: CQL expressions embedded in the query string are NOT enforced by this tool.",
        };
      }
      // No --space and requireSpaceOnSearch not set → no space to check, pass through
      return { allowed: true };
    }
    // Has --space: check against the read list
    return checkSpacePermission(spaceFlag, "read", config);
  }

  // ── find --space ─────────────────────────────────────────────────────────
  if (subcommand === "find") {
    const spaceFlag = extractFlag(args, "--space");
    if (!spaceFlag) {
      // `find` without --space searches all spaces — fail open (no space to check)
      return { allowed: true };
    }
    return checkSpacePermission(spaceFlag, "read", config);
  }

  // ── create — space key is the second positional (args[2]) ────────────────
  if (subcommand === "create") {
    const spaceKey = extractSecondPositional(args);
    if (!spaceKey) return { allowed: true }; // malformed call, let confluence handle it
    return checkSpacePermission(spaceKey, "write", config);
  }

  // ── copy-tree — two page IDs (source and target parent) ─────────────────
  // Both must clear the write space check.
  if (subcommand === "copy-tree") {
    const sourceId = extractFirstPositional(args);
    const targetId = extractSecondPositional(args);

    const targets: string[] = [];
    if (sourceId) targets.push(sourceId);
    if (targetId) targets.push(targetId);

    for (const target of targets) {
      const spaceKey = await resolveSpaceKey(target, executor, timeoutMs, cache, profileArgs);
      if (!spaceKey) continue; // can't resolve → fail open
      const check = checkSpacePermission(spaceKey, "write", config);
      if (!check.allowed) return check;
    }
    return { allowed: true };
  }

  // ── move — source page (write) + target parent page (write) ─────────────
  if (subcommand === "move") {
    const sourceId = extractFirstPositional(args);
    const targetId = extractSecondPositional(args);

    const targets: string[] = [];
    if (sourceId) targets.push(sourceId);
    if (targetId) targets.push(targetId);

    for (const target of targets) {
      const spaceKey = await resolveSpaceKey(target, executor, timeoutMs, cache, profileArgs);
      if (!spaceKey) continue;
      const check = checkSpacePermission(spaceKey, "write", config);
      if (!check.allowed) return check;
    }
    return { allowed: true };
  }

  // ── All remaining commands: single first positional (page ID or URL) ─────
  const firstPositional = extractFirstPositional(args);
  if (!firstPositional) return { allowed: true }; // no target → fail open

  const spaceKey = await resolveSpaceKey(firstPositional, executor, timeoutMs, cache, profileArgs);
  if (!spaceKey) return { allowed: true }; // can't resolve → fail open

  return checkSpacePermission(spaceKey, kind, config);
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
    "  confluence search <query> [--limit <n>] [--space <key>]",
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
    rawConfig.allowReadSpaces !== undefined ||
    rawConfig.allowWriteSpaces !== undefined ||
    rawConfig.requireSpaceOnSearch !== undefined ||
    rawConfig.timeout !== undefined ||
    rawConfig.profile !== undefined;

  const config: ConfluenceConfig = hasConfig ? (rawConfig as ConfluenceConfig) : {};
  const timeoutMs = (config.timeout ?? 30) * 1000;
  const defaultProfile = config.profile;
  const executor: Executor = context.executor ?? realExecutor;

  // In-process cache: page ID → space key.  Lives for the handler lifetime
  // (i.e. a single beige gateway session).
  const spaceCache = new Map<string, string>();

  return async (args: string[]): Promise<{ output: string; exitCode: number }> => {
    // ── No args ───────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Extract command path ──────────────────────────────────────────────
    const commandPath = extractCommandPath(args);

    // The bare subcommand (first token only, no "profile list" compound form)
    // used for classification and space enforcement.
    const subcommand = commandPath.split(" ")[0];

    // ── Command-level permission check ────────────────────────────────────
    if (commandPath) {
      const perm = checkPermission(commandPath, config, hasConfig);
      if (!perm.allowed) {
        return { output: `Permission denied: ${perm.reason}`, exitCode: 1 };
      }
    }

    // ── Space-level permission check ──────────────────────────────────────
    if (subcommand) {
      // Build the profile args that should be prepended to any info lookups
      const profileArgsForLookup: string[] =
        defaultProfile && !args.includes("--profile")
          ? ["--profile", defaultProfile]
          : args.includes("--profile")
          ? ["--profile", extractFlag(args, "--profile") ?? defaultProfile ?? ""]
          : [];

      const spacePerm = await enforceSpacePolicy(
        subcommand,
        args,
        config,
        executor,
        timeoutMs,
        spaceCache,
        profileArgsForLookup
      );
      if (!spacePerm.allowed) {
        return { output: `Permission denied: ${spacePerm.reason}`, exitCode: 1 };
      }
    }

    // ── Inject default profile if configured and not already in args ───────
    let finalArgs = [...args];
    if (defaultProfile && !finalArgs.includes("--profile")) {
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
