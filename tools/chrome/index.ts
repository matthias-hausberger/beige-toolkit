/**
 * chrome tool
 *
 * Wraps the chrome-devtools-mcp server, giving beige agents full control of a
 * Chrome browser.  Each agent gets its own persistent profile directory so
 * cookies, logins, and storage survive gateway restarts.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * On the first tool call for an agent, the handler:
 *   1. Spawns `npx chrome-devtools-mcp@<version>` as a subprocess.
 *   2. Performs the MCP initialize handshake over its stdin/stdout.
 *   3. Caches the live McpClient for subsequent calls (reused across calls).
 *
 * The process is kept alive until:
 *   - It has been idle for more than `idleTimeoutMinutes` (default 30).
 *   - The gateway shuts down (all processes are killed).
 *   - The process crashes — in which case an error is returned and the next
 *     call triggers a fresh spawn.
 *
 * ── Agent interface ──────────────────────────────────────────────────────────
 *
 * Agents pass the MCP tool name as the first argument, followed by params in
 * one of two forms:
 *
 *   Flag-style (simple):
 *     chrome navigate_page --url https://example.com
 *     chrome take_screenshot
 *
 *   JSON (complex / structured):
 *     chrome fill_form {"elements":[{"uid":"u1","value":"hello"}]}
 *     chrome evaluate_script {"function":"() => document.title"}
 *
 * Special:
 *     chrome --list-tools       List available MCP tools and their parameters.
 *
 * ── Screenshots ─────────────────────────────────────────────────────────────
 *
 * take_screenshot saves the image to /workspace/media/inbound/ (accessible
 * inside the agent's sandbox).  The absolute host-side path is resolved from
 * the agent's cwd injected via BEIGE_WORKSPACE env var, falling back to
 * process.cwd().  The tool injects a suitable filePath into the MCP params
 * automatically — agents do not need to supply it.
 *
 * ── Permission model ─────────────────────────────────────────────────────────
 *
 * allowTools / denyTools work identically to the slack tool's allow/deny
 * pattern but operate on MCP tool names.  Deny beats allow.  When neither is
 * set, all tools are permitted.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 *
 * createHandler accepts an optional second argument for testing:
 *
 *   { processManager?, workspaceDir? }
 *
 * Tests inject a stub ProcessManager and a temp workspace directory.
 */

import { mkdirSync } from "fs";
import { resolve, join } from "path";
import { ProcessManager, resolveBeigeDataDir, type ManagedProcess } from "./process-manager.js";
import type { McpTool } from "./mcp-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChromeConfig {
  slim?: boolean;
  headless?: boolean;
  channel?: string;
  viewport?: string;
  idleTimeoutMinutes?: number;
  version?: string;
  allowTools?: string | string[];
  denyTools?: string | string[];
  noUsageStatistics?: boolean;
  timeout?: number;
  proxyServer?: string;
  acceptInsecureCerts?: boolean;
}

/** Subset of ProcessManager used — injectable for testing. */
export interface ProcessManagerLike {
  getOrCreate(agentName: string): Promise<ManagedProcess>;
  killAll(): void;
}

export interface ChromeContext {
  processManager?: ProcessManagerLike;
  /** Absolute path to the workspace root on the host. Default: process.cwd(). */
  workspaceDir?: string;
}

interface IncomingSessionContext {
  sessionKey?: string;
  channel?: string;
  agentName?: string;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: IncomingSessionContext
) => Promise<{ output: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((s) => s.trim()).filter(Boolean);
}

function checkToolPermission(
  toolName: string,
  config: ChromeConfig
): { allowed: boolean; reason?: string } {
  const deny = toArray(config.denyTools);
  const allow = toArray(config.allowTools);

  if (deny.includes(toolName)) {
    return { allowed: false, reason: `tool '${toolName}' is blocked by denyTools` };
  }
  if (allow.length > 0 && !allow.includes(toolName)) {
    return {
      allowed: false,
      reason: `tool '${toolName}' is not in allowTools.\nPermitted tools: ${allow.join(", ")}`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  listTools: boolean;
  toolName: string | null;
  params: Record<string, unknown>;
}

/**
 * Parse agent args into a tool name + params object.
 *
 * Supported forms:
 *   --list-tools
 *   <toolName>                              (no params)
 *   <toolName> {"key":"value",...}          (JSON object)
 *   <toolName> --key value --flag           (flag-style)
 */
export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { listTools: false, toolName: null, params: {} };
  }

  if (args[0] === "--list-tools") {
    return { listTools: true, toolName: null, params: {} };
  }

  const toolName = args[0];
  const rest = args.slice(1);

  if (rest.length === 0) {
    return { listTools: false, toolName, params: {} };
  }

  // Try JSON object form first
  if (rest.length === 1 && rest[0].startsWith("{")) {
    try {
      const params = JSON.parse(rest[0]);
      if (params && typeof params === "object" && !Array.isArray(params)) {
        return { listTools: false, toolName, params };
      }
    } catch {
      // Fall through to flag parsing
    }
  }

  // Flag-style parsing: --key value, --key=value, --flag (boolean)
  const params: Record<string, unknown> = {};
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      // Handle --key=value
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        params[key] = coerceValue(val);
        i++;
        continue;
      }
      const key = arg.slice(2);
      // Peek at next arg — if it doesn't start with -- it's the value
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        params[key] = coerceValue(rest[i + 1]);
        i += 2;
      } else {
        // Boolean flag
        params[key] = true;
        i++;
      }
    } else {
      // Positional — skip (shouldn't normally appear after tool name)
      i++;
    }
  }

  return { listTools: false, toolName, params };
}

/** Coerce a string value to boolean, number, or keep as string. */
function coerceValue(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== "") return n;
  return s;
}

// ---------------------------------------------------------------------------
// Screenshot path resolution
// ---------------------------------------------------------------------------

const SCREENSHOT_DIR = "media/inbound";

function resolveScreenshotPath(workspaceDir: string): string {
  const dir = join(workspaceDir, SCREENSHOT_DIR);
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return join(dir, `screenshot-${timestamp}.png`);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatMcpResult(
  result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
  screenshotFilePath?: string
): string {
  const parts: string[] = [];

  for (const item of result.content) {
    if (item.type === "text" && item.text) {
      parts.push(item.text);
    } else if (item.type === "image") {
      // Image was saved to disk — point the agent at the in-sandbox path
      const sandboxPath = screenshotFilePath
        ? `/${SCREENSHOT_DIR}/${screenshotFilePath.split(SCREENSHOT_DIR).pop()?.replace(/^\//, "")}`
        : "(unknown path)";
      parts.push(`Screenshot saved to: ${sandboxPath}`);
    }
  }

  return parts.join("\n---\n") || "(no output)";
}

function formatToolList(tools: McpTool[]): string {
  if (tools.length === 0) return "No tools available.";
  const lines = [`${tools.length} tools available:`, ""];
  for (const t of tools) {
    lines.push(`  ${t.name}`);
    if (t.description) {
      lines.push(`    ${t.description}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function usageText(): string {
  return [
    "Usage:",
    "  chrome --list-tools",
    "  chrome <tool-name>",
    "  chrome <tool-name> --param1 value1 --param2 value2",
    '  chrome <tool-name> \'{"param1":"value1","param2":"value2"}\'',
    "",
    "Examples:",
    "  chrome take_snapshot",
    "  chrome navigate_page --url https://example.com",
    "  chrome take_screenshot",
    "  chrome click --uid button-42",
    '  chrome fill_form \'{"elements":[{"uid":"u1","value":"hello"}]}\'',
    "  chrome evaluate_script --function '() => document.title'",
    "  chrome --list-tools",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// createHandler
// ---------------------------------------------------------------------------

export function createHandler(
  rawConfig: Record<string, unknown>,
  context: ChromeContext = {}
): ToolHandler {
  const config = rawConfig as ChromeConfig;
  const timeoutMs = (config.timeout ?? 60) * 1000;
  const idleTimeoutMs = (config.idleTimeoutMinutes ?? 30) * 60 * 1000;

  // Build the real ProcessManager if no stub is injected
  const processManager: ProcessManagerLike =
    context.processManager ??
    new ProcessManager({
      beigeDataDir: resolveBeigeDataDir(),
      version: config.version ?? "latest",
      slim: config.slim ?? false,
      headless: config.headless ?? false,
      channel: config.channel ?? "stable",
      viewport: config.viewport,
      proxyServer: config.proxyServer,
      acceptInsecureCerts: config.acceptInsecureCerts ?? false,
      noUsageStatistics: config.noUsageStatistics ?? true,
      idleTimeoutMs,
    });

  // Workspace dir for screenshot saving
  const workspaceDir =
    context.workspaceDir ??
    process.env.BEIGE_WORKSPACE ??
    process.cwd();

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: IncomingSessionContext
  ): Promise<{ output: string; exitCode: number }> => {
    // ── Identify agent ──────────────────────────────────────────────────────
    const agentName = sessionContext?.agentName ?? "unknown";

    if (agentName === "unknown") {
      return {
        output: [
          "Error: agent identity unknown.",
          "This tool requires BEIGE_AGENT_NAME to be set in the sandbox environment.",
          "Ensure you are running beige >= 0.1.3.",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── No args ─────────────────────────────────────────────────────────────
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    // ── Parse args ───────────────────────────────────────────────────────────
    const parsed = parseArgs(args);

    // ── Get or create the MCP process for this agent ─────────────────────────
    let managed: ManagedProcess;
    try {
      managed = await processManager.getOrCreate(agentName);
    } catch (err) {
      return {
        output: [
          "Error: failed to start chrome-devtools-mcp.",
          err instanceof Error ? err.message : String(err),
          "",
          "Make sure Node.js and npx are on the gateway's PATH.",
          "The browser process will be retried on your next call.",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── --list-tools ─────────────────────────────────────────────────────────
    if (parsed.listTools) {
      try {
        const tools = await managed.client.listTools();
        managed.touch();
        return { output: formatToolList(tools), exitCode: 0 };
      } catch (err) {
        return {
          output: `Error listing tools: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    }

    // ── Require tool name ────────────────────────────────────────────────────
    if (!parsed.toolName) {
      return {
        output: ["Error: tool name required.", "", usageText()].join("\n"),
        exitCode: 1,
      };
    }

    // ── Permission check ─────────────────────────────────────────────────────
    const perm = checkToolPermission(parsed.toolName, config);
    if (!perm.allowed) {
      return {
        output: `Permission denied: ${perm.reason}`,
        exitCode: 1,
      };
    }

    // ── Screenshot path injection ─────────────────────────────────────────────
    let screenshotFilePath: string | undefined;
    const finalParams = { ...parsed.params };

    if (
      (parsed.toolName === "take_screenshot" || parsed.toolName === "screenshot") &&
      !finalParams.filePath
    ) {
      screenshotFilePath = resolveScreenshotPath(workspaceDir);
      finalParams.filePath = screenshotFilePath;
    }

    // ── Invoke MCP tool ───────────────────────────────────────────────────────
    try {
      const result = await managed.client.callTool(
        parsed.toolName,
        finalParams,
        timeoutMs
      );
      managed.touch();

      const output = formatMcpResult(result, screenshotFilePath);
      const exitCode = result.isError ? 1 : 0;
      return { output, exitCode };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Check if the process died mid-call
      if (managed.client.isClosed) {
        return {
          output: [
            `Error: chrome-devtools-mcp process for agent '${agentName}' has exited unexpectedly.`,
            msg,
            "",
            "The browser will be restarted on your next call.",
          ].join("\n"),
          exitCode: 1,
        };
      }

      return {
        output: `Error calling tool '${parsed.toolName}': ${msg}`,
        exitCode: 1,
      };
    }
  };
}
