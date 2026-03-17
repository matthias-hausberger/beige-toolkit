/**
 * MCP process manager for the chrome tool.
 *
 * Manages one chrome-devtools-mcp process per agent. Processes are:
 *   - Started lazily on first tool call for that agent.
 *   - Reused across subsequent calls (long-lived stdio connection).
 *   - Killed automatically after a configurable idle timeout.
 *   - NOT silently restarted on crash — callers receive an error and the
 *     process is cleaned up so the next call triggers a fresh spawn.
 */

import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { McpClient } from "./mcp-client.js";

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
  client: McpClient;
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
   */
  async getOrCreate(agentName: string): Promise<ManagedProcess> {
    const existing = this.processes.get(agentName);
    if (existing && !existing.client.isClosed) {
      return existing;
    }

    // Either never started or has crashed — clean up stale entry
    if (existing) {
      existing.kill();
      this.processes.delete(agentName);
    }

    const managed = await this.spawn(agentName);
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
   */
  killAll(): void {
    for (const [name, p] of this.processes) {
      p.kill();
      this.processes.delete(name);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async spawn(agentName: string): Promise<ManagedProcess> {
    const { config } = this;

    // Profile directory — one per agent, persistent across restarts.
    const profileDir = resolve(
      config.beigeDataDir,
      "browser-profiles",
      agentName
    );
    mkdirSync(profileDir, { recursive: true });

    // Build CLI args for chrome-devtools-mcp
    const mcpArgs = buildMcpArgs(config, profileDir);

    // Spawn via npx
    const child = spawn(
      "npx",
      ["-y", `chrome-devtools-mcp@${config.version}`, ...mcpArgs],
      {
        stdio: ["pipe", "pipe", "pipe"],
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
      if (!child.killed) child.kill("SIGTERM");
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
// beigeDataDir helper — mirrors src/paths.ts logic, self-contained
// ---------------------------------------------------------------------------

export function resolveBeigeDataDir(): string {
  const env = process.env.BEIGE_HOME;
  if (env) return resolve(env);
  return resolve(homedir(), ".beige");
}
