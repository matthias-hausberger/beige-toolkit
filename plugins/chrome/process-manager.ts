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
 * ── Process lifecycle & cleanup ──────────────────────────────────────────────
 *
 * Each child process is spawned with `detached: true` so it becomes the leader
 * of a new OS process group.  This means `process.kill(-pid, signal)` sends
 * the signal to the *entire* tree (npx → chrome-devtools-mcp → Chrome), not
 * just the immediate child.
 *
 * Kill escalation: SIGTERM is sent first; if the process group has not exited
 * within KILL_ESCALATION_MS milliseconds it is sent SIGKILL.
 *
 * Gateway shutdown: the ProcessManager registers once-handlers for SIGTERM,
 * SIGINT and the Node.js "exit" event so that killAll() is always called when
 * the gateway process stops.  Handlers are unregistered when killAll() runs to
 * avoid accumulating listeners across multiple ProcessManager instances (only
 * relevant in tests).
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
// Constants
// ---------------------------------------------------------------------------

/**
 * How long to wait after SIGTERM before escalating to SIGKILL.
 * Chrome sometimes hangs on SIGTERM (e.g. during a GPU flush), so we give it
 * a short grace period before forcing the issue.
 */
const KILL_ESCALATION_MS = 5_000;

// ---------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------

/** Known Google Chrome binary locations (tried in order, first match wins). */
export const CHROME_PATHS = [
  "/opt/google/chrome/chrome",           // Google-packaged deb/rpm (most common on Linux)
  "/opt/google/chrome-beta/chrome",      // beta channel
  "/opt/google/chrome-unstable/chrome",  // dev channel
  "/usr/bin/google-chrome",              // some distro packages
  "/usr/bin/google-chrome-stable",       // explicit stable symlink
];

/** Known Chromium binary locations (tried in order, first match wins). */
export const CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/lib/chromium/chromium",
  "/app/bin/chromium",                   // Flatpak
];

/**
 * Find an available browser executable.
 *
 * Tries Chrome paths first.  If none exist and `fallbackToChromium` is true,
 * tries Chromium paths.  Returns `null` when nothing is found — in that case
 * chrome-devtools-mcp will use its own default discovery logic.
 *
 * The `_existsFn` parameter exists solely for unit-testing without touching
 * the real filesystem.
 */
export function findBrowserExecutable(
  fallbackToChromium: boolean,
  _existsFn: (p: string) => boolean = existsSync
): string | null {
  for (const p of CHROME_PATHS) {
    if (_existsFn(p)) return p;
  }
  if (fallbackToChromium) {
    for (const p of CHROMIUM_PATHS) {
      if (_existsFn(p)) return p;
    }
  }
  return null;
}

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
  /**
   * Headless mode for the browser.
   *
   *   true       — always headless (no display required)
   *   false      — always use a display (fails if none is available)
   *   "fallback" — use a display if one is available, otherwise fall back to
   *                headless automatically (see resolveHeadless)
   */
  headless: boolean | "fallback";
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
  /**
   * Absolute path to the browser binary.
   * When set, skips auto-detection entirely and passes the path directly to
   * chrome-devtools-mcp via --executable-path.
   */
  executablePath?: string;
  /**
   * Fall back to Chromium if no Chrome binary is found during auto-detection.
   * Default: true.
   */
  fallbackToChromium: boolean;
  /**
   * X11 display to use when spawning the browser (Linux only).
   * Set to e.g. ":1" to open the browser on TigerVNC virtual screen 1.
   * Defaults to inheriting the gateway process's DISPLAY env var.
   * Has no effect when headless resolves to true or on non-Linux platforms.
   * When headless is "fallback", this display is also the one probed for
   * existence — if it does not exist the browser starts headless instead.
   */
  display?: string;
}

export interface ManagedProcess {
  client: McpClientLike;
  /** Resets the idle timer. Called on every successful tool invocation. */
  touch(): void;
  /** Kill the process immediately (SIGTERM → SIGKILL escalation). */
  kill(): void;
}

// ---------------------------------------------------------------------------
// Process group kill helper
// ---------------------------------------------------------------------------

/**
 * Terminate an entire OS process group.
 *
 * When the child was spawned with `detached: true` it becomes the process
 * group leader.  Sending a signal to `-pid` (negative PID) delivers it to
 * every process in that group — including grandchildren like Chrome itself.
 *
 * Falls back to a plain `child.kill(signal)` on platforms where process
 * groups are not supported (Windows) or when the PID is no longer available.
 */
function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  try {
    if (child.pid != null) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Process group already gone — try the direct child as a last resort
  }
  try {
    child.kill(signal);
  } catch {
    // Already dead
  }
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private config: ProcessConfig;

  // Bound shutdown callbacks stored so we can remove them in killAll().
  private onSigterm: () => void;
  private onSigint:  () => void;
  private onExit:    () => void;

  constructor(config: ProcessConfig) {
    this.config = config;

    // Wire gateway shutdown → kill all managed Chrome processes.
    // Using once() so repeated invocations (e.g. SIGTERM then exit) are safe.
    this.onSigterm = () => this.killAll();
    this.onSigint  = () => this.killAll();
    this.onExit    = () => this.killAll();

    process.once("SIGTERM", this.onSigterm);
    process.once("SIGINT",  this.onSigint);
    process.once("exit",    this.onExit);
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
   *
   * Also removes the OS signal listeners registered in the constructor so
   * this object can be garbage-collected cleanly (important in tests where
   * many ProcessManager instances may be created).
   */
  killAll(): void {
    // Deregister shutdown listeners first to avoid double-invocation
    process.off("SIGTERM", this.onSigterm);
    process.off("SIGINT",  this.onSigint);
    process.off("exit",    this.onExit);

    for (const [name, p] of this.processes) {
      p.kill();
      this.processes.delete(name);
    }
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

    // Build spawn environment.
    // DISPLAY is only meaningful on Linux/X11; setting it on other platforms
    // is harmless but also has no effect.
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Disable update checks that can produce unexpected stdout noise
      NO_UPDATE_NOTIFIER: "1",
    };
    if (config.display) {
      spawnEnv.DISPLAY = config.display;
    }

    // Spawn via npx.
    //
    // detached: true — places the child in its own OS process group.
    // This is the key to reliable cleanup: we can send a signal to the
    // *entire* process group (npx → chrome-devtools-mcp → Chrome) by using
    // process.kill(-pid, signal).  Without this, killing the npx wrapper
    // would leave chrome-devtools-mcp and Chrome as orphan processes.
    //
    // We do NOT call child.unref() — we want the child to hold the event
    // loop open and we want Node.js to track it.
    const child = spawn(
      "npx",
      ["-y", `chrome-devtools-mcp@${config.version}`, ...mcpArgs],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnEnv,
        detached: true,
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
      killProcessGroup(child, "SIGKILL");
      throw new Error(
        `Failed to initialize chrome-devtools-mcp for agent '${agentName}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Idle timer — auto-kill after inactivity
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // SIGTERM → SIGKILL escalation timer
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      if (escalationTimer) { clearTimeout(escalationTimer); escalationTimer = undefined; }
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        managed.kill();
        this.processes.delete(agentName);
      }, config.idleTimeoutMs);
    };

    const killProcess = () => {
      clearTimers();

      // Send SIGTERM to the entire process group first.
      killProcessGroup(child, "SIGTERM");

      // If the process group is still alive after KILL_ESCALATION_MS, force it.
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        killProcessGroup(child, "SIGKILL");
      }, KILL_ESCALATION_MS);
    };

    const managed: ManagedProcess = {
      client,
      touch: resetIdle,
      kill: killProcess,
    };

    // Start the idle clock immediately after spawn
    resetIdle();

    // When the child exits (for any reason), clear timers and remove from map.
    child.once("exit", () => {
      clearTimers();
      this.processes.delete(agentName);
    });

    return managed;
  }
}

// ---------------------------------------------------------------------------
// Display detection
// ---------------------------------------------------------------------------

/**
 * Resolve the effective headless flag for a given config.
 *
 * | config value | display socket exists? | result  |
 * |--------------|------------------------|---------|
 * | true         | (any)                  | true    |
 * | false        | (any)                  | false   |
 * | "fallback"   | yes                    | false   |
 * | "fallback"   | no / unknown           | true    |
 *
 * Detection for "fallback":
 *   X11 servers — both real and virtual (TigerVNC, TightVNC, Xvfb, etc.) —
 *   create a Unix domain socket at `/tmp/.X11-unix/X<N>` where N is the
 *   display number.  We check for that socket rather than relying solely on
 *   the DISPLAY env var, which may be set but pointing at a server that is no
 *   longer running.
 *
 *   The display to probe is resolved in this order:
 *     1. The explicit `display` config option (e.g. ":1")
 *     2. The DISPLAY environment variable of the gateway process
 *     3. Nothing found → no display → headless
 *
 * The `_existsFn` parameter is injectable for unit tests so the real
 * filesystem is never touched during testing.
 */
export function resolveHeadless(
  headless: boolean | "fallback",
  display?: string,
  _existsFn: (p: string) => boolean = existsSync
): boolean {
  if (headless !== "fallback") return headless;

  // Determine which display to probe (explicit config wins over env var)
  const displayValue = display ?? process.env.DISPLAY;
  if (!displayValue) {
    // No display configured or inherited — start headless
    return true;
  }

  // Parse the display number from ":N" or "hostname:N" or ":N.screen" forms.
  // We only care about the display number (the part after the last colon,
  // before an optional dot), because the socket name is always X<N>.
  const match = displayValue.match(/:(\d+)(?:\.\d+)?$/);
  if (!match) {
    // Unrecognised format — be safe and start headless
    return true;
  }

  const socketPath = `/tmp/.X11-unix/X${match[1]}`;
  const displayExists = _existsFn(socketPath);

  // Return false (use display) only if the socket is actually present
  return !displayExists;
}

// ---------------------------------------------------------------------------
// CLI arg builder
// ---------------------------------------------------------------------------

/**
 * Build CLI arguments for chrome-devtools-mcp.
 *
 * The optional `_existsFn` is injectable for unit tests so we can simulate
 * filesystem state without touching the real disk.
 */
export function buildMcpArgs(
  config: ProcessConfig,
  profileDir: string,
  _existsFn: (p: string) => boolean = existsSync
): string[] {
  const args: string[] = [
    `--user-data-dir=${profileDir}`,
  ];

  // Resolve browser executable:
  //   1. Explicit config path (user knows exactly where their browser is).
  //   2. Auto-detect: Chrome first, then Chromium if fallbackToChromium is set.
  //   3. null → omit flag and let chrome-devtools-mcp do its own discovery.
  const exe = config.executablePath
    ?? findBrowserExecutable(config.fallbackToChromium, _existsFn);
  if (exe) args.push(`--executablePath=${exe}`);

  if (config.slim) args.push("--slim");
  if (resolveHeadless(config.headless, config.display, _existsFn)) args.push("--headless");
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
