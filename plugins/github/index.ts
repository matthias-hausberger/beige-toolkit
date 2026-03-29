import { spawn } from "node:child_process";
import { join } from "node:path";
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
 * Default executor: spawns real gh CLI and returns its output.
 *
 * When a token is provided it is passed via the GH_TOKEN environment variable,
 * which gh (and the underlying git credential helper) recognises for both
 * classic personal access tokens (ghp_…) and fine-grained PATs (github_pat_…).
 * This overrides any token that may already be stored in ~/.config/gh/ so that
 * the agent-specific token always takes precedence.
 *
 * When no token is configured the process environment is inherited as-is, so
 * any existing gh auth (via `gh auth login`) continues to work.
 *
 * The cwd parameter sets the working directory for the gh subprocess. This is
 * critical for commands like `pr create` that read .git/config to discover the
 * repository. The cwd should be the agent's workspace directory on the gateway
 * host (sessionContext.workspaceDir).
 */
/**
 * Resolve full path to gh binary.
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
 *     precedence over any locally stored credential. Both classic personal
 *     access tokens (ghp_…) and fine-grained PATs (github_pat_…) are accepted
 *     by gh without any special handling on our side.
 *   - When no token is configured the tool falls back to whatever gh auth is
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

    // Warn about `github repo clone` protocol behaviour.
    //
    // `gh repo clone` derives its clone URL from gh's git_protocol config
    // (default: "https"). This means the cloned remote will be an HTTPS URL,
    // which will fail on subsequent git push/fetch/pull if the git tool is
    // configured for SSH-only authentication.
    //
    // We can't change gh's behaviour here, so we surface a clear warning so
    // that agents can use `git clone git@github.com:...` instead.
    if (subcommand === "repo" && rest[0] === "clone") {
      const repoArg = rest[1]; // e.g. "myorg/myrepo" or a full URL
      // Only warn for shorthand owner/repo form — if a full SSH URL is passed
      // explicitly (git@... or ssh://...) it will work fine.
      const isShorthand = repoArg && !repoArg.includes("://") && !repoArg.startsWith("git@");
      if (isShorthand) {
        const sshUrl = `git@github.com:${repoArg}.git`;
        return {
          output:
            `'github repo clone ${repoArg}' would clone using HTTPS by default ` +
            `(gh's git_protocol setting), which will fail if the git tool is ` +
            `configured for SSH-only authentication.\n\n` +
            `Use git clone with an explicit SSH URL instead:\n` +
            `  git clone ${sshUrl}\n\n` +
            `This guarantees SSH authentication regardless of gh's config.`,
          exitCode: 1,
        };
      }
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

// ── GitHub Polling Channel Adapter ──────────────────────────────────────
// Adds GitHub notification polling capability to the GitHub plugin.

import type {
  PluginInstance,
  PluginContext,
  PluginRegistrar,
  ChannelAdapter,
} from "@matthias-hausberger/beige";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

/**
 * GitHub Polling Configuration
 */
interface GitHubPollingConfig {
  enabled: boolean;
  username: string;
  pollIntervalSeconds: number;
  respondTo: "mentions" | "all" | "watched";
  includeFullThread: boolean;
  watchedRepos?: string[];
  watchedPrs?: number[];
  agentMapping: { default: string; [repo: string]: string };
}

/**
 * GitHub Notification Type
 */
interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    title: string;
    type: string;
    url: string;
    latest_comment_url?: string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
}

/**
 * Issue Comment Type
 */
interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  user: {
    login: string;
  };
  created_at: string;
}

/**
 * Polling State
 */
interface PollingState {
  timer: NodeJS.Timeout | null;
  lastCheckTimestamp: string;
  seenNotificationIds: Set<string>;
}

/**
 * Create GitHub plugin with polling channel adapter
 */
export function createPlugin(
  config: Record<string, unknown>,
  ctx: PluginContext
): PluginInstance {
  const manifestPath = joinPath(import.meta.dirname!, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const handler = createHandler(config);

  // Extract polling configuration
  const pollingConfig = (config.polling || {}) as GitHubPollingConfig;

  // Set defaults
  pollingConfig.enabled = pollingConfig.enabled ?? false;
  pollingConfig.pollIntervalSeconds = pollingConfig.pollIntervalSeconds ?? 60;
  pollingConfig.respondTo = (pollingConfig.respondTo as "mentions" | "all" | "watched") ?? "mentions";
  pollingConfig.includeFullThread = pollingConfig.includeFullThread ?? true;
  pollingConfig.agentMapping = pollingConfig.agentMapping ?? { default: "assistant" };

  // Polling state
  const state: PollingState = {
    timer: null,
    lastCheckTimestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    seenNotificationIds: new Set(),
  };

  // Resolve gh binary
  const ghBin = resolveGhBin(config);

  // ---------------------------------------------------------------------------
  // Helper: Execute gh command
  // ---------------------------------------------------------------------------

  async function execGh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const token = typeof config.token === "string" && config.token.trim()
        ? config.token.trim()
        : undefined;
      const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

      const proc = spawn(ghBin, args, {
        env,
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
          stderr: `Failed to spawn gh (${ghBin}): ${err.message}`,
          exitCode: 1,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: Fetch notifications since timestamp
  // ---------------------------------------------------------------------------

  async function fetchNotifications(since: string): Promise<GitHubNotification[]> {
    const result = await execGh([
      "api",
      "notifications",
      "--paginate",
      "--jq",
      ".[]",
      "-f",
      `since=${since}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to fetch notifications: ${result.stderr}`);
    }

    const lines = result.stdout.trim().split("\n").filter((l) => l);
    return lines.map((line) => JSON.parse(line));
  }

  // ---------------------------------------------------------------------------
  // Helper: Fetch issue comment details
  // ---------------------------------------------------------------------------

  async function fetchIssueComment(url: string): Promise<IssueComment | null> {
    const result = await execGh(["api", "--jq", ".", url]);

    if (result.exitCode !== 0) {
      ctx.log.warn(`Failed to fetch issue comment from ${url}: ${result.stderr}`);
      return null;
    }

    return JSON.parse(result.stdout);
  }

  // ---------------------------------------------------------------------------
  // Helper: Check if notification is relevant based on config
  // ---------------------------------------------------------------------------

  async function isNotificationRelevant(
    notif: GitHubNotification
  ): Promise<boolean> {
    const repo = notif.repository.full_name;

    // Check if repo is in watched list (if configured)
    if (pollingConfig.respondTo === "watched") {
      const watchedRepos = pollingConfig.watchedRepos;
      if (watchedRepos && watchedRepos.length > 0 && !watchedRepos.includes(repo)) {
        return false;
      }
    }

    // Extract issue/PR number from URL
    const match = notif.subject.url.match(/\/(issues|pull)\/(\d+)$/);
    if (!match) {
      return false;
    }
    const number = parseInt(match[2], 10);

    // Check if PR/issue is in watched list (if configured)
    const watchedPrs = pollingConfig.watchedPrs;
    if (watchedPrs && watchedPrs.length > 0 && !watchedPrs.includes(number)) {
      return false;
    }

    // Filter by respondTo mode
    switch (pollingConfig.respondTo) {
      case "all":
        // All notifications pass through
        return true;

      case "watched": {
        // Only notifications from watched repos/PRs
        const reposLen = pollingConfig.watchedRepos?.length ?? 0;
        const prsLen = pollingConfig.watchedPrs?.length ?? 0;
        if (reposLen > 0 || prsLen > 0) {
          return true;
        }
        // If no watched repos/PRs, fall back to mentions
        return (
          notif.reason === "mention" ||
          notif.reason === "team_mention" ||
          notif.reason === "review_requested"
        );
      }

      case "mentions":
      default:
        // Only mentions and review requests
        if (notif.reason === "mention" || notif.reason === "team_mention" || notif.reason === "review_requested") {
          return true;
        }

        // For issue comments, check if @mentioned in body
        if (notif.subject.type === "IssueComment" && notif.subject.latest_comment_url) {
          const comment = await fetchIssueComment(notif.subject.latest_comment_url);
          if (comment?.body?.includes(`@${pollingConfig.username}`)) {
            return true;
          }
        }

        // For PR comments, check if @mentioned in body
        if (notif.subject.type === "PullRequestReviewComment" && notif.subject.latest_comment_url) {
          const comment = await fetchIssueComment(notif.subject.latest_comment_url);
          if (comment?.body?.includes(`@${pollingConfig.username}`)) {
            return true;
          }
        }

        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: Resolve agent name for a repo
  // ---------------------------------------------------------------------------

  function resolveAgent(repo: string): string {
    return pollingConfig.agentMapping[repo] ?? pollingConfig.agentMapping.default;
  }

  // ---------------------------------------------------------------------------
  // Helper: Build session key from notification
  // ---------------------------------------------------------------------------

  function getSessionKey(notif: GitHubNotification): string {
    const match = notif.subject.url.match(/\/repos\/([^\/]+)\/([^\/]+)\/(issues|pull)\/(\d+)$/);
    if (match) {
      const owner = match[1];
      const repo = match[2];
      const type = match[3]; // "issues" or "pull"
      const number = match[4];
      return `github:${owner}/${repo}:${type}/${number}`;
    }
    return `github:${notif.id}`;
  }

  // ---------------------------------------------------------------------------
  // Helper: Build context for agent
  // ---------------------------------------------------------------------------

  async function buildEventContext(notif: GitHubNotification): Promise<string> {
    const lines: string[] = [
      `GitHub Event: ${notif.subject.type}`,
      ``,
      `Repository: ${notif.repository.full_name}`,
      `URL: ${notif.repository.html_url}`,
      ``,
      `Subject: ${notif.subject.title}`,
      `Subject Type: ${notif.subject.type}`,
      `Subject URL: ${notif.subject.url}`,
      ``,
      `Notification Reason: ${notif.reason}`,
      `Last Updated: ${notif.updated_at}`,
      ``,
    ];

    lines.push(
      `---`,
      ``,
      `You can reply to this by using the GitHub tool:`,
      `- Comment on issue/PR: github issue comment <number> <comment>`,
      `- Create issue: github issue create --repo <repo> --title <title> --body <body>`,
      `- Merge PR: github pr merge <number>`,
      ``,
      `What would you like to do?`,
    );

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Main polling loop
  // ---------------------------------------------------------------------------

  async function pollGitHubNotifications(): Promise<void> {
    try {
      ctx.log.info("Polling GitHub notifications...");

      // Fetch notifications since last check
      const notifications = await fetchNotifications(state.lastCheckTimestamp);

      if (notifications.length === 0) {
        ctx.log.info("No new notifications");
        return;
      }

      ctx.log.info(`Found ${notifications.length} new notifications`);

      // Deduplicate and filter
      const relevant: GitHubNotification[] = [];
      for (const notif of notifications) {
        if (state.seenNotificationIds.has(notif.id)) {
          continue;
        }
        state.seenNotificationIds.add(notif.id);

        const isRelevant = await isNotificationRelevant(notif);
        if (isRelevant) {
          relevant.push(notif);
        }
      }

      ctx.log.info(`${relevant.length} relevant notifications after filtering`);

      // Group by session key
      const grouped = new Map<string, GitHubNotification[]>();
      for (const notif of relevant) {
        const sessionKey = getSessionKey(notif);
        if (!grouped.has(sessionKey)) {
          grouped.set(sessionKey, []);
        }
        grouped.get(sessionKey)!.push(notif);
      }

      // Route each group to agent
      for (const [sessionKey, events] of grouped.entries()) {
        await routeEventGroup(sessionKey, events);
      }

      // Update last check timestamp
      state.lastCheckTimestamp = new Date().toISOString();

    } catch (err) {
      ctx.log.error(`GitHub polling error: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Route grouped events to agent
  // ---------------------------------------------------------------------------

  async function routeEventGroup(
    sessionKey: string,
    events: GitHubNotification[]
  ): Promise<void> {
    const repo = events[0].repository.full_name;
    const agentName = resolveAgent(repo);

    // Build combined context for all events
    const contexts: string[] = [];
    for (const event of events) {
      const context = await buildEventContext(event);
      contexts.push(context);
    }

    const combinedContext = contexts.join("\n\n" + "=".repeat(80) + "\n\n");

    // Check if session is active (steer) or create new
    if (ctx.isSessionActive(sessionKey)) {
      ctx.log.info(`Steering active session: ${sessionKey}`);
      await ctx.steerSession(sessionKey, combinedContext);
    } else {
      ctx.log.info(`Creating new session: ${sessionKey}`);
      await ctx.prompt(sessionKey, agentName, combinedContext);
    }
  }

  // ---------------------------------------------------------------------------
  // Channel adapter (no proactive messaging)
  // ---------------------------------------------------------------------------

  const channelAdapter: ChannelAdapter = {
    supportsMessaging(): boolean {
      return false; // Polling doesn't support proactive messaging
    },
    async sendMessage(): Promise<void> {
      throw new Error("GitHub polling channel does not support proactive messaging");
    },
    async sendPhoto(): Promise<void> {
      throw new Error("GitHub polling channel does not support sending photos");
    },
  };

  // ---------------------------------------------------------------------------
  // Plugin instance
  // ---------------------------------------------------------------------------

  return {
    register(reg: PluginRegistrar): void {
      // Register tool
      reg.tool({
        name: manifest.name,
        description: manifest.description,
        commands: manifest.commands,
        handler,
      });

      // Register channel adapter
      reg.channel(channelAdapter);
    },

    async start(): Promise<void> {
      if (!pollingConfig.enabled) {
        ctx.log.info("GitHub polling is disabled (polling.enabled: false in config)");
        return;
      }

      ctx.log.info("Starting GitHub polling...");

      const pollInterval = pollingConfig.pollIntervalSeconds * 1000;

      // Start polling loop
      state.timer = setInterval(() => {
        pollGitHubNotifications();
      }, pollInterval);

      ctx.log.info(`GitHub polling started (interval: ${pollingConfig.pollIntervalSeconds}s)`);
      ctx.log.info(`Respond to: ${pollingConfig.respondTo}`);
      ctx.log.info(`Include full thread: ${pollingConfig.includeFullThread}`);
    },

    async stop(): Promise<void> {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      ctx.log.info("GitHub polling stopped");
    },
  };
}
