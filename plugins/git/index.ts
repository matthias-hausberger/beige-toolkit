/**
 * git tool
 *
 * Runs git commands against the agent's workspace on the gateway host.
 *
 * ── Why gateway-side ─────────────────────────────────────────────────────────
 *
 * The agent's /workspace inside the Docker container is a bind mount of
 * ~/.beige/agents/<name>/workspace/ on the gateway host. Both sides see the
 * same files. Running git on the gateway host means:
 *
 *   1. The SSH private key never needs to enter the container — it lives at
 *      ~/.beige/agents/<name>/ssh/id_ed25519 on the host and is used directly
 *      by the git subprocess spawned by this handler.
 *   2. The agent cannot read the key via exec/cat — the ssh/ directory is
 *      never mounted into the container (only workspace/ and launchers/ are).
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 *
 * Two modes, configured via config.auth.mode:
 *
 *   "ssh" (default)
 *     Uses <agentDir>/ssh/id_ed25519 and <agentDir>/ssh/known_hosts as
 *     defaults. Both can be overridden with sshKeyPath / sshKnownHostsPath
 *     in config — useful for shared deploy keys or non-standard locations.
 *     Provision the per-agent default with:
 *       ssh-keygen -t ed25519 -C "beige-<name>-agent" \
 *         -f ~/.beige/agents/<name>/ssh/id_ed25519 -N ""
 *       ssh-keyscan github.com > ~/.beige/agents/<name>/ssh/known_hosts
 *
 *   "https"
 *     Uses a PAT from config.auth.token. Injects it via a transient
 *     GIT_ASKPASS helper script that is created, used, and deleted within
 *     the single git invocation. No credential store is touched.
 *
 * SSH invocations always set IdentitiesOnly=yes so the gateway operator's
 * own ~/.ssh/ keys and any loaded ssh-agent keys are completely ignored.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *
 * Permanently blocked (cannot be enabled by any config):
 *   git config            — prevents SSH command override or identity spoofing
 *   git push --force      — unless allowForcePush: true in config
 *   git push --force-with-lease — same
 *   git filter-branch / git fast-import — history rewriting
 *   git archive --remote  — arbitrary remote read
 *
 * allowedCommands controls the subcommand allowlist (default: safe set).
 * deniedCommands adds extra blocks; deny beats allow.
 * allowedRemotes glob-matches remote URLs before push/fetch/pull/clone.
 *
 * ── Workspace ────────────────────────────────────────────────────────────────
 *
 * Every git invocation is scoped to the agent's workspace via:
 *   git -C <workspaceDir> <subcommand> [args...]
 *
 * workspaceDir comes from sessionContext.workspaceDir injected by the gateway
 * socket server. If absent (e.g. in tests), it falls back to cwd.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 *
 * createHandler accepts an optional second argument for testing:
 *   { executor? }
 *
 * The executor replaces the real git spawn. Tests inject a stub.
 */

import { spawn, execFileSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
   * Relative working directory from workspace root (e.g. "repos/myrepo").
   * Populated by the tool-client from the container's cwd when the agent
   * invokes git from a subdirectory of /workspace (e.g. via cd+exec).
   */
  cwd?: string;
}

export interface GitAuthConfig {
  /**
   * "ssh" (default) — SSH key authentication.
   *   Falls back to <agentDir>/ssh/id_ed25519 and <agentDir>/ssh/known_hosts
   *   when sshKeyPath / sshKnownHostsPath are not set in config.
   * "https" — PAT authentication via GIT_ASKPASS.
   */
  mode?: "ssh" | "https";

  /**
   * Absolute path to SSH private key.
   * Defaults to <agentDir>/ssh/id_ed25519 when not set.
   */
  sshKeyPath?: string;

  /**
   * Absolute path to known_hosts file.
   * Defaults to <agentDir>/ssh/known_hosts when not set.
   */
  sshKnownHostsPath?: string;

  /**
   * HTTPS PAT (Personal Access Token). Only used when mode is "https".
   * Can use ${ENV_VAR} for injection by the config system.
   */
  token?: string;

  /**
   * HTTPS username. Only used when mode is "https".
   * Defaults to "x-access-token". Can use ${ENV_VAR} for injection.
   */
  user?: string;
}

export interface GitIdentityConfig {
  /** Git author/committer name. Can use ${ENV_VAR} for injection. */
  name?: string;
  /** Git author/committer email. Can use ${ENV_VAR} for injection. */
  email?: string;
}

export interface GitConfig {
  /**
   * Full path to the git binary (e.g. "/opt/homebrew/bin/git").
   * When not set, falls back to "git" (must be on PATH).
   */
  binPath?: string;
  allowedCommands?: string | string[];
  deniedCommands?: string | string[];
  /**
   * Glob-style patterns matched against remote URLs.
   * If set, push/fetch/pull/clone are only permitted to matching remotes.
   * Pattern is matched against the URL with a simple prefix+wildcard check.
   */
  allowedRemotes?: string | string[];
  /** Allow --force and --force-with-lease on push. Default: false. */
  allowForcePush?: boolean;
  identity?: GitIdentityConfig;
  auth?: GitAuthConfig;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Executor = (
  args: string[],
  env: Record<string, string>,
  cwd: string
) => Promise<ExecResult>;

export interface GitContext {
  executor?: Executor;
}

// ---------------------------------------------------------------------------
// Default allowed subcommands
// ---------------------------------------------------------------------------

/**
 * Safe default set — covers normal read/write workflow without any destructive
 * or auth-mutating operations.
 *
 * Notably absent: "config", "filter-branch", "fast-import", "archive",
 * "bisect", "gc", "reflog" (mutation), "clean" (destructive).
 */
const DEFAULT_ALLOWED: readonly string[] = [
  "clone",
  "pull",
  "push",
  "fetch",
  "add",
  "commit",
  "status",
  "diff",
  "log",
  "show",
  "checkout",
  "branch",
  "merge",
  "rebase",
  "stash",
  "remote",
  "tag",
  "mv",
  "rm",
  "restore",
  "reset",
  "rev-parse",
  "ls-files",
  "shortlog",
];

/**
 * Subcommands that are permanently blocked regardless of config.
 * No config option can re-enable these.
 */
const ALWAYS_BLOCKED: readonly string[] = [
  "config",          // could override SSH command, user identity, credential helper
  "filter-branch",   // history rewriting
  "fast-import",     // history rewriting
  "archive",         // --remote flag allows arbitrary remote reads
];

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Extract the first non-flag token from args — the git subcommand.
 * git accepts global flags before the subcommand (e.g. -C, --no-pager).
 * We skip known global flags and their values to find the real subcommand.
 *
 * Known value-taking global flags: -C, --git-dir, --work-tree, -c,
 * --namespace, --super-prefix, --config-env.
 */
export function extractSubcommand(args: string[]): string | null {
  const valueTaking = new Set(["-C", "--git-dir", "--work-tree", "-c", "--namespace"]);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") return args[i + 1] ?? null;
    if (valueTaking.has(arg)) {
      i += 2; // skip flag and its value
      continue;
    }
    if (arg.startsWith("-")) {
      i++;
      continue;
    }
    return arg;
  }
  return null;
}

/**
 * Check whether args contain a force-push flag.
 */
export function hasForcePushFlag(args: string[]): boolean {
  return args.some(
    (a) =>
      a === "--force" ||
      a === "-f" ||
      a === "--force-with-lease" ||
      a.startsWith("--force-with-lease=")
  );
}

/**
 * Extract the remote URL from clone args.
 *
 * git clone [options] <url> [dir]
 *
 * Handles value-taking flags (--depth, --branch, --origin, etc.) so their
 * values are not mistaken for the URL. The URL is the first positional
 * argument after the "clone" subcommand token and any flags.
 */
export function extractCloneUrl(args: string[]): string | null {
  // Flags that consume the next token as a value
  const valueTakingFlags = new Set([
    "--depth", "--branch", "-b", "--origin", "-o", "--upload-pack", "-u",
    "--reference", "--reference-if-able", "--separate-git-dir",
    "--jobs", "-j", "--filter", "--recurse-submodules",
    "--shallow-since", "--shallow-exclude",
  ]);

  let pastSubcmd = false;
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!pastSubcmd) {
      pastSubcmd = true; // skip "clone"
      continue;
    }
    if (valueTakingFlags.has(arg)) {
      skipNext = true;
      continue;
    }
    // --flag=value form — skip entirely
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Remote URL allowlist
// ---------------------------------------------------------------------------

/**
 * Match a URL against a pattern.
 *
 * Patterns are simple glob strings with a single trailing wildcard:
 *   "github.com/myorg/*"  matches "github.com/myorg/myrepo"
 *   "github.com/myorg/myrepo"  matches exactly
 *
 * The URL is normalised: protocol prefix (https://, git@, ssh://) and
 * trailing .git are stripped before matching.
 */
export function normaliseRemoteUrl(url: string): string {
  let u = url.trim();
  // Strip https:// or http://
  u = u.replace(/^https?:\/\//, "");
  // ssh://git@github.com/org/repo → github.com/org/repo  (ssh + git@ combined)
  u = u.replace(/^ssh:\/\/git@/, "");
  // ssh://github.com/org/repo → github.com/org/repo
  u = u.replace(/^ssh:\/\//, "");
  // git@github.com:org/repo → github.com/org/repo
  u = u.replace(/^git@([^:/]+):/, "$1/");
  // git@github.com/org/repo → github.com/org/repo (fallback for unusual forms)
  u = u.replace(/^git@/, "");
  // Strip trailing .git
  u = u.replace(/\.git$/, "");
  return u;
}

export function remoteMatchesPattern(url: string, pattern: string): boolean {
  const normUrl = normaliseRemoteUrl(url);
  const normPattern = normaliseRemoteUrl(pattern);

  if (normPattern.endsWith("/*")) {
    const prefix = normPattern.slice(0, -2); // strip /*
    return normUrl === prefix || normUrl.startsWith(prefix + "/");
  }
  if (normPattern.endsWith("*")) {
    const prefix = normPattern.slice(0, -1);
    return normUrl.startsWith(prefix);
  }
  return normUrl === normPattern;
}

export function remoteAllowed(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => remoteMatchesPattern(url, p));
}

// ---------------------------------------------------------------------------
// Auth — build SSH env or HTTPS askpass
// ---------------------------------------------------------------------------

/**
 * Build the GIT_SSH_COMMAND string for SSH authentication.
 * Always sets IdentitiesOnly=yes to prevent fallback to operator's own keys.
 */
function buildSshCommand(keyPath: string, knownHostsPath: string): string {
  return [
    "ssh",
    "-i", keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsPath}`,
    "-o", "BatchMode=yes",       // never prompt interactively
    "-o", "PasswordAuthentication=no", // SSH key only, no password fallback
  ].join(" ");
}

/**
 * Write a transient GIT_ASKPASS helper script to a temp file.
 * Returns the path; caller must delete it after the git call.
 *
 * The script echoes the token when git asks for a password.
 * For username, it echoes the user (default: x-access-token).
 */
function writeAskpassScript(token: string, user: string): string {
  const id = randomBytes(8).toString("hex");
  const path = join(tmpdir(), `beige-git-askpass-${id}.sh`);

  const script = [
    "#!/bin/sh",
    // git calls GIT_ASKPASS with the prompt as $1
    // "Username" prompt → echo the user
    // anything else (password prompt) → echo the token
    `case "$1" in`,
    `  Username*) echo ${JSON.stringify(user)} ;;`,
    `  *)         echo ${JSON.stringify(token)} ;;`,
    `esac`,
    "",
  ].join("\n");

  writeFileSync(path, script, { mode: 0o700 });
  return path;
}

interface AuthEnv {
  env: Record<string, string>;
  /** Cleanup function — removes any temp files written for this invocation. */
  cleanup: () => void;
}

/**
 * Build the env additions and cleanup function for the configured auth mode.
 * Returns an object with env vars to merge into the git subprocess env and
 * a cleanup() to call after the process exits.
 */
export function buildAuthEnv(
  config: GitConfig,
  sessionContext: SessionContext
): AuthEnv {
  const auth = config.auth ?? {};
  const mode = auth.mode ?? "ssh";

  if (mode === "https") {
    const token = auth.token ?? "";
    const user = auth.user ?? "x-access-token";

    if (!token) {
      console.warn(
        `[git tool] HTTPS mode: token is not configured. ` +
        `Push/clone to private repos will fail.`
      );
    }

    const askpassPath = writeAskpassScript(token, user);

    return {
      env: {
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0", // never prompt interactively
      },
      cleanup: () => {
        try { unlinkSync(askpassPath); } catch { /* already gone */ }
      },
    };
  }

  // SSH mode — config values override the per-agent defaults derived from agentDir.
  const agentDir = sessionContext.agentDir;
  if (!agentDir && (!auth.sshKeyPath || !auth.sshKnownHostsPath)) {
    console.warn(
      "[git tool] SSH mode: sessionContext.agentDir is not set and no explicit " +
      "sshKeyPath/sshKnownHostsPath configured. " +
      "This usually means the tool is being called outside a normal agent session. " +
      "SSH authentication will fail."
    );
  }

  const sshDir = agentDir ? join(agentDir, "ssh") : "";
  const keyPath = auth.sshKeyPath
    ? resolve(auth.sshKeyPath)
    : join(sshDir, "id_ed25519");
  const knownHostsPath = auth.sshKnownHostsPath
    ? resolve(auth.sshKnownHostsPath)
    : join(sshDir, "known_hosts");

  return {
    env: {
      GIT_SSH_COMMAND: buildSshCommand(keyPath, knownHostsPath),
      GIT_TERMINAL_PROMPT: "0",
    },
    cleanup: () => { /* nothing to clean up for SSH */ },
  };
}

// ---------------------------------------------------------------------------
// Identity env
// ---------------------------------------------------------------------------

export function buildIdentityEnv(identity: GitIdentityConfig | undefined): Record<string, string> {
  if (!identity) return {};

  const env: Record<string, string> = {};

  if (identity.name) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_COMMITTER_NAME = identity.name;
  }
  if (identity.email) {
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Real executor
// ---------------------------------------------------------------------------

/**
 * Resolve the full path to the git binary.
 *
 * Priority:
 *   1. Explicit binPath from config (e.g. "/opt/homebrew/bin/git")
 *   2. Auto-detect via `which git` at startup — works even when the gateway
 *      process inherits a minimal PATH (GUI launchers, systemd, etc.) as
 *      long as the login shell knows where git lives.
 *   3. Fall back to bare "git" and let spawn() fail with a helpful message.
 */
function resolveGitBin(config: GitConfig): string {
  const raw = config as Record<string, unknown>;
  if (typeof raw.binPath === "string" && raw.binPath.trim()) {
    return raw.binPath.trim();
  }
  return resolveBin("git");
}

/**
 * Try to locate a binary by name using `which`.
 * Returns the absolute path if found, otherwise the bare name as fallback.
 */
function resolveBin(name: string): string {
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim();
  } catch {
    // which failed — try common Homebrew/Linuxbrew paths
    const commonPaths = [
      `/opt/homebrew/bin/${name}`,
      `/home/linuxbrew/.linuxbrew/bin/${name}`,
      `/usr/local/bin/${name}`,
    ];
    for (const p of commonPaths) {
      try {
        // Check if file exists and is executable
        execFileSync("test", ["-x", p]);
        return p;
      } catch { /* not found here */ }
    }
    return name;
  }
}

export const createExecutor = (bin: string): Executor => (args, env, cwd) =>
  new Promise((resolve_) => {
    // Merge with a clean env: inherit PATH and locale vars from the gateway
    // process but do NOT pass through SSH_AUTH_SOCK, SSH_AGENT_PID, or any
    // credential-related vars. Explicitly add the auth env we computed.
    const cleanEnv: Record<string, string> = {};

    // Passthrough: only what git actually needs from the host env
    const passthrough = [
      "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
      "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    ];
    for (const key of passthrough) {
      const val = process.env[key];
      if (val !== undefined) cleanEnv[key] = val;
    }

    // Explicitly block SSH agent and credential passthrough
    // (these are NOT in our passthrough list, so they won't appear — but
    // be explicit for documentation purposes and defence in depth)
    delete cleanEnv.SSH_AUTH_SOCK;
    delete cleanEnv.SSH_AGENT_PID;
    delete cleanEnv.GIT_SSH_COMMAND; // we set our own below
    delete cleanEnv.GIT_ASKPASS;     // we set our own below

    // Prevent git from reading the operator's system or global git config
    // (~/.gitconfig). Without this, git finds the gateway operator's
    // credential helper (e.g. macOS Keychain) via HOME and silently
    // authenticates as the operator instead of the configured agent identity.
    // GIT_CONFIG_NOSYSTEM suppresses /etc/gitconfig; GIT_CONFIG_GLOBAL
    // (git ≥ 2.32) redirects the per-user config to /dev/null.
    cleanEnv.GIT_CONFIG_NOSYSTEM = "1";
    cleanEnv.GIT_CONFIG_GLOBAL = "/dev/null";

    // Apply our computed auth/identity env on top
    Object.assign(cleanEnv, env);

    // Disable git's interactive prompts globally
    cleanEnv.GIT_TERMINAL_PROMPT = cleanEnv.GIT_TERMINAL_PROMPT ?? "0";

    const proc = spawn(bin, args, {
      env: cleanEnv,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      resolve_({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve_({
        stdout: "",
        stderr: `Failed to spawn git (${bin}): ${err.message}. Is git installed on the gateway host? If git is not on PATH, set binPath in the git tool config (e.g. binPath: "/opt/homebrew/bin/git").`,
        exitCode: 1,
      });
    });
  });

/** Default executor using bare "git" — for backward compatibility. */
export const defaultExecutor: Executor = createExecutor("git");

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function usageText(allowedCmds: Set<string>): string {
  const permitted = allowedCmds.size > 0
    ? [...allowedCmds].join(", ")
    : "(none)";
  return [
    "Usage: git <subcommand> [args...]",
    "",
    "Runs git in the agent's workspace on the gateway host.",
    "",
    "Examples:",
    "  git status",
    "  git add .",
    "  git commit -m 'feat: add feature'",
    "  git push origin main",
    "  git pull",
    "  git log --oneline",
    "",
    `Permitted subcommands: ${permitted}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// createHandler
// ---------------------------------------------------------------------------

export function createHandler(
  rawConfig: Record<string, unknown>,
  context: GitContext = {}
): ToolHandler {
  const config = rawConfig as GitConfig;
  const executor = context.executor ?? createExecutor(resolveGitBin(config));

  // Resolve allowed set once at startup
  const allowedSet = new Set<string>(
    config.allowedCommands !== undefined
      ? toArray(config.allowedCommands)
      : DEFAULT_ALLOWED
  );
  for (const cmd of toArray(config.deniedCommands)) {
    allowedSet.delete(cmd);
  }
  // Always blocked — remove even if someone put them in allowedCommands
  for (const cmd of ALWAYS_BLOCKED) {
    allowedSet.delete(cmd);
  }

  const allowedRemotePatterns = toArray(config.allowedRemotes);
  const allowForcePush = config.allowForcePush ?? false;
  const identityConfig = config.identity;

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: SessionContext
  ): Promise<{ output: string; exitCode: number }> => {
    // ── No args ─────────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(allowedSet), exitCode: 1 };
    }

    // ── Extract subcommand ───────────────────────────────────────────────────
    const subcommand = extractSubcommand(args);

    if (!subcommand) {
      return { output: usageText(allowedSet), exitCode: 1 };
    }

    // ── Always-blocked check ─────────────────────────────────────────────────
    if (ALWAYS_BLOCKED.includes(subcommand)) {
      return {
        output: `Permission denied: 'git ${subcommand}' is permanently blocked. ` +
          `This subcommand cannot be enabled through configuration.`,
        exitCode: 1,
      };
    }

    // ── Allowlist check ──────────────────────────────────────────────────────
    if (!allowedSet.has(subcommand)) {
      const permitted = [...allowedSet].join(", ") || "(none)";
      return {
        output: `Permission denied: subcommand '${subcommand}' is not allowed for this agent.\n` +
          `Permitted subcommands: ${permitted}`,
        exitCode: 1,
      };
    }

    // ── Force-push check ─────────────────────────────────────────────────────
    if (subcommand === "push" && hasForcePushFlag(args) && !allowForcePush) {
      return {
        output: "Permission denied: force-push is not allowed for this agent.\n" +
          "Set allowForcePush: true in the git tool config to enable it.",
        exitCode: 1,
      };
    }

    // ── Remote URL check for clone ───────────────────────────────────────────
    if (subcommand === "clone" && allowedRemotePatterns.length > 0) {
      const url = extractCloneUrl(args);
      if (url && !remoteAllowed(url, allowedRemotePatterns)) {
        return {
          output: `Permission denied: remote '${url}' does not match any allowed remote pattern.\n` +
            `Allowed patterns: ${allowedRemotePatterns.join(", ")}`,
          exitCode: 1,
        };
      }
    }

    // ── Resolve working directory ────────────────────────────────────────────
    // The workspace dir on the gateway host is the same directory that is
    // mounted at /workspace inside the container.
    //
    // If the agent invoked git from a subdirectory of /workspace (e.g. via
    // `cd /workspace/myrepo && git status`), the tool-client captures the
    // container's cwd as a relative path ("myrepo") and the gateway puts it
    // in sessionContext.cwd. We join it with workspaceDir so that git runs
    // in the correct subdirectory on the host — this is essential for agents
    // that clone repos into the workspace and then operate inside them.
    const workspaceRoot = sessionContext?.workspaceDir ?? process.cwd();
    const cwd = sessionContext?.cwd
      ? join(workspaceRoot, sessionContext.cwd)
      : workspaceRoot;

    // ── Build auth env ───────────────────────────────────────────────────────
    const { env: authEnv, cleanup } = buildAuthEnv(config, sessionContext ?? {});

    // ── Build ceiling env ────────────────────────────────────────────────────
    // Prevent git from traversing up past the workspace into a parent git
    // repository (e.g. when the workspace lives inside a pnpm monorepo or
    // any other git-tracked parent directory on the gateway host).
    // GIT_CEILING_DIRECTORIES tells git to stop its .git search at or above
    // the listed paths, so only repos rooted inside the workspace are found.
    const ceilingEnv: Record<string, string> = {
      GIT_CEILING_DIRECTORIES: cwd,
    };

    // ── Build identity env ───────────────────────────────────────────────────
    const identityEnv = buildIdentityEnv(identityConfig);

    // ── Merge all env additions ──────────────────────────────────────────────
    const env = { ...authEnv, ...identityEnv, ...ceilingEnv };

    // ── Execute ──────────────────────────────────────────────────────────────
    let result: ExecResult;
    try {
      result = await executor(args, env, cwd);
    } finally {
      cleanup();
    }

    if (result.exitCode === 0) {
      const out = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
      return { output: out || "(no output)", exitCode: 0 };
    }

    const out = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
    return {
      output: out || `git exited with code ${result.exitCode}`,
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
