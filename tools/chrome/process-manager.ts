/**
 * MCP process manager for the chrome tool.
 *
 * Manages one chrome-devtools-mcp process per agent. Processes are:
 *   - Started lazily on first tool call for that agent.
 *   - Reused across subsequent calls (long-lived stdio connection).
 *   - Killed automatically after a configurable idle timeout.
 *   - NOT silently restarted on crash — callers receive an error and the
 *     process is cleaned up so the next call triggers a fresh spawn.
 *
 * ── Download directory ──────────────────────────────────────────────────────
 *
 * To route Chrome file-downloads into the agent's workspace, the manager
 * writes Chrome's `Default/Preferences` JSON file into the profile directory
 * **before** chrome-devtools-mcp (and thus Puppeteer/Chrome) is started.
 * This sets `download.default_directory` so that Chrome saves all downloads
 * to `{workspaceDir}/media/inbound/` without prompting.
 *
 * Why not CDP `Browser.setDownloadBehavior`?  That command is scoped to the
 * CDP *connection* it was sent on.  A side-channel WebSocket cannot influence
 * Puppeteer's own connection, so downloads triggered through Puppeteer would
 * still land in the default location.  Chrome Preferences, by contrast, are
 * read once at startup and apply globally — regardless of which CDP
 * connection initiates the download.
 */

import { spawn } from "child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { resolve, join } from "path";
import { McpClient, type McpClientLike } from "./mcp-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessConfig {
  /** Path to the beige home directory (for profile storage). */
  beigeDataDir: string;
  /** chrome-devtools-mcp npm version. Default: "latest". */
  version: string;
  /** --slim mode. */
  slim: boolean;
  /** --headless mode. */
  headless: boolean;
  /** Chrome channel. */
  channel: string;
  /** Viewport string e.g. "1280x720". */
  viewport?: string;
  /** Proxy server URL. */
  proxyServer?: string;
  /** Accept insecure TLS certs. */
  acceptInsecureCerts: boolean;
  /** Opt out of usage statistics. Default: true. */
  noUsageStatistics: boolean;
  /** Idle timeout in milliseconds before auto-kill. */
  idleTimeoutMs: number;
}

export interface ManagedProcess {
  client: McpClientLike;
  /** Resets the idle timer. Called on every successful tool invocation. */
  touch(): void;
  /** Kill the process immediately. */
  kill(): void;
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private config: ProcessConfig;

  constructor(config: ProcessConfig) {
    this.config = config;
  }

  /**
   * Get or create the MCP process for the given agent.
   * Throws if the process has crashed (call again to respawn).
   *
   * @param workspaceDir — host-side workspace path for the agent. Used to
   *   configure Chrome's download directory so that downloads land in
   *   `{workspaceDir}/media/inbound/`.
   */
  async getOrCreate(agentName: string, workspaceDir?: string): Promise<ManagedProcess> {
    const existing = this.processes.get(agentName);
    if (existing && !existing.client.isClosed) {
      return existing;
    }

    // Either never started or has crashed — clean up stale entry
    if (existing) {
      existing.kill();
      this.processes.delete(agentName);
    }

    const managed = await this.spawn(agentName, workspaceDir);
    this.processes.set(agentName, managed);
    return managed;
  }

  /**
   * Kill and remove the process for the given agent, if any.
   */
  kill(agentName: string): void {
    const p = this.processes.get(agentName);
    if (p) {
      p.kill();
      this.processes.delete(agentName);
    }
  }

  /**
   * Kill all managed processes. Called on gateway shutdown.
   * Waits up to 5 seconds per process for graceful shutdown.
   */
  async killAll(): Promise<void> {
    const killPromises: Promise<void>[] = [];

    for (const [name, managed] of this.processes) {
      killPromises.push(
        new Promise<void>((resolve) => {
          // Set a timeout to force kill if graceful shutdown takes too long
          const timeout = setTimeout(() => {
            resolve();
          }, 5000);

          // Wait for the client to close (process exited)
          managed.client.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });

          // Start graceful shutdown
          managed.kill();
        })
      );
      this.processes.delete(name);
    }

    await Promise.all(killPromises);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async spawn(agentName: string, workspaceDir?: string): Promise<ManagedProcess> {
    const { config } = this;

    // Profile directory — one per agent, persistent across restarts.
    const profileDir = resolve(
      config.beigeDataDir,
      "browser-profiles",
      agentName
    );
    mkdirSync(profileDir, { recursive: true });

    // Configure Chrome's download directory via Preferences.
    // This must happen BEFORE Chrome starts.  chrome-devtools-mcp launches
    // Chrome lazily on the first MCP tool call, so writing the file here
    // (during spawn, before the MCP handshake) guarantees the prefs are in
    // place when Chrome eventually reads them.
    if (workspaceDir) {
      const downloadDir = join(workspaceDir, "media", "inbound");
      mkdirSync(downloadDir, { recursive: true });
      setChromeDownloadPreferences(profileDir, downloadDir);
    }

    // Remove saved session data so Chrome starts with a clean new tab
    // instead of restoring tabs from the previous session.
    const sessionsDir = join(profileDir, "Default", "Sessions");
    try { rmSync(sessionsDir, { recursive: true }); } catch { /* doesn't exist — fine */ }

    // Build CLI args for chrome-devtools-mcp
    const mcpArgs = buildMcpArgs(config, profileDir);

    // Spawn via npx
    // Use detached: true to create a new process group, which allows us to
    // kill the entire process tree (including Chrome subprocesses) on cleanup.
    const child = spawn(
      "npx",
      ["-y", `chrome-devtools-mcp@${config.version}`, ...mcpArgs],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // Create new process group for clean tree termination
        env: {
          ...process.env,
          // Disable update checks that can produce unexpected stdout noise
          NO_UPDATE_NOTIFIER: "1",
        },
      }
    );

    // If spawn itself fails (npx not found etc.) reject immediately
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      // Give it a tick to detect immediate spawn errors before proceeding
      setImmediate(resolve);
    });

    const client = new McpClient(child.stdin!, child.stdout!);

    // Drain stderr to avoid backpressure (don't log — agents don't see it)
    child.stderr?.resume();

    // Initialize the MCP handshake
    try {
      await client.initialize();
    } catch (err) {
      child.kill("SIGKILL");
      throw new Error(
        `Failed to initialize chrome-devtools-mcp for agent '${agentName}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Idle timer — auto-kill after inactivity
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        managed.kill();
        this.processes.delete(agentName);
      }, config.idleTimeoutMs);
    };

    const killProcess = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!child.killed) {
        try {
          // Kill entire process group (negative PID) to ensure Chrome
          // subprocesses are also terminated. Use SIGKILL for reliability
          // since Chrome may not respond to SIGTERM.
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Process already dead or PID not found — ignore
        }
      }
    };

    const managed: ManagedProcess = {
      client,
      touch: resetIdle,
      kill: killProcess,
    };

    // Start the idle clock immediately after spawn
    resetIdle();

    // When the child exits unexpectedly, remove from map (next call will respawn)
    child.once("exit", () => {
      if (idleTimer) clearTimeout(idleTimer);
      this.processes.delete(agentName);
    });

    return managed;
  }
}

// ---------------------------------------------------------------------------
// CLI arg builder
// ---------------------------------------------------------------------------

function buildMcpArgs(config: ProcessConfig, profileDir: string): string[] {
  const args: string[] = [
    `--user-data-dir=${profileDir}`,
  ];

  if (config.slim) args.push("--slim");
  if (config.headless) args.push("--headless");
  if (config.channel !== "stable") args.push(`--channel=${config.channel}`);
  if (config.viewport) args.push(`--viewport=${config.viewport}`);
  if (config.proxyServer) args.push(`--proxy-server=${config.proxyServer}`);
  if (config.acceptInsecureCerts) args.push("--accept-insecure-certs");
  if (config.noUsageStatistics) args.push("--no-usage-statistics");

  return args;
}

// ---------------------------------------------------------------------------
// Chrome Preferences
// ---------------------------------------------------------------------------

/**
 * Write (or patch) Chrome's `Default/Preferences` file to configure:
 *   - download directory → `downloadDir`
 *   - session restore   → always start with a blank new-tab page
 *
 * Chrome reads this JSON file once at startup, so it must be written
 * **before** the browser process is launched.
 *
 * If a `Preferences` file already exists (from a previous session) only the
 * relevant keys are merged in; all other preferences are preserved.
 */
export function setChromeDownloadPreferences(
  profileDir: string,
  downloadDir: string
): void {
  const defaultDir = join(profileDir, "Default");
  mkdirSync(defaultDir, { recursive: true });

  const prefsPath = join(defaultDir, "Preferences");

  let prefs: Record<string, unknown> = {};
  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
    } catch {
      // Corrupted file — start fresh
      prefs = {};
    }
  }

  // ── Download directory ──────────────────────────────────────────────────
  const download = (prefs.download ?? {}) as Record<string, unknown>;
  download.default_directory = downloadDir;
  download.prompt_for_download = false;
  prefs.download = download;

  const savefile = (prefs.savefile ?? {}) as Record<string, unknown>;
  savefile.default_directory = downloadDir;
  prefs.savefile = savefile;

  // ── Session restore — always start fresh ────────────────────────────────
  // 1 = "Open the New Tab page", 4 = "Continue where you left off"
  const session = (prefs.session ?? {}) as Record<string, unknown>;
  session.restore_on_startup = 1;
  prefs.session = session;

  writeFileSync(prefsPath, JSON.stringify(prefs), "utf-8");
}

// ---------------------------------------------------------------------------
// beigeDataDir helper — mirrors src/paths.ts logic, self-contained
// ---------------------------------------------------------------------------

export function resolveBeigeDataDir(): string {
  const env = process.env.BEIGE_HOME;
  if (env) return resolve(env);
  return resolve(homedir(), ".beige");
}
