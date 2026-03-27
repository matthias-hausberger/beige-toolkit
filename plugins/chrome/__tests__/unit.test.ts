/**
 * Unit tests for the chrome tool.
 *
 * No real chrome-devtools-mcp process is spawned. All tests use injected stubs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHandler, parseArgs, type ProcessManagerLike } from "../index.js";
import type { ManagedProcess } from "../process-manager.js";
import {
  setChromeDownloadPreferences,
  findBrowserExecutable,
  buildMcpArgs,
  CHROME_PATHS,
  CHROMIUM_PATHS,
  type ProcessConfig,
} from "../process-manager.js";
import type { McpToolCallResult, McpTool } from "../mcp-client.js";

// ---------------------------------------------------------------------------
// Stub builder
// ---------------------------------------------------------------------------

type StubResult = McpToolCallResult | Error;

function makeProcessManager(
  toolResults: Record<string, StubResult> = {},
  tools: McpTool[] = []
): ProcessManagerLike & {
  calls: Array<{ toolName: string; args: Record<string, unknown> }>;
  spawnCount: number;
  lastWorkspaceDir: string | undefined;
} {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let spawnCount = 0;
  let closed = false;
  let lastWorkspaceDir: string | undefined;

  const client = {
    get isClosed() { return closed; },
    async listTools() { return tools; },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ toolName: name, args });
      const result = toolResults[name];
      if (!result) return { content: [{ type: "text" as const, text: `called ${name}` }], isError: false };
      if (result instanceof Error) throw result;
      return result;
    },
    async initialize() {},
  };

  const managed: ManagedProcess = {
    client,
    touch() {},
    kill() { closed = true; },
  };

  return {
    calls,
    get spawnCount() { return spawnCount; },
    get lastWorkspaceDir() { return lastWorkspaceDir; },
    async getOrCreate(_agentName: string, _workspaceDir?: string) {
      spawnCount++;
      lastWorkspaceDir = _workspaceDir;
      return managed;
    },
    killAll() { closed = true; },
  };
}

const SESSION = { agentName: "coder" };

let tmpBeigeDir: string;
let tmpWorkspaceDir: string;
beforeEach(() => {
  tmpBeigeDir = mkdtempSync(join(tmpdir(), "chrome-test-"));
  tmpWorkspaceDir = join(tmpBeigeDir, "agents", "coder", "workspace");
});
afterEach(() => {
  try { rmSync(tmpBeigeDir, { recursive: true }); } catch {}
});

/** Build session context with workspaceDir for a given agent name */
function makeSession(agentName: string): { agentName: string; workspaceDir: string } {
  return { agentName, workspaceDir: join(tmpBeigeDir, "agents", agentName, "workspace") };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("returns listTools for --list-tools", () => {
    expect(parseArgs(["--list-tools"]).listTools).toBe(true);
  });

  it("returns null toolName for empty args", () => {
    expect(parseArgs([]).toolName).toBeNull();
  });

  it("parses tool name with no params", () => {
    const r = parseArgs(["take_snapshot"]);
    expect(r.toolName).toBe("take_snapshot");
    expect(r.params).toEqual({});
  });

  it("parses flag-style params", () => {
    const r = parseArgs(["navigate_page", "--url", "https://example.com"]);
    expect(r.toolName).toBe("navigate_page");
    expect(r.params).toEqual({ url: "https://example.com" });
  });

  it("parses --key=value style", () => {
    const r = parseArgs(["navigate_page", "--url=https://example.com"]);
    expect(r.params.url).toBe("https://example.com");
  });

  it("parses boolean flags", () => {
    const r = parseArgs(["take_screenshot", "--fullPage"]);
    expect(r.params.fullPage).toBe(true);
  });

  it("coerces numeric values", () => {
    const r = parseArgs(["new_page", "--timeout", "5000"]);
    expect(r.params.timeout).toBe(5000);
  });

  it("coerces boolean string values", () => {
    const r = parseArgs(["click", "--dblClick", "true"]);
    expect(r.params.dblClick).toBe(true);
  });

  it("parses JSON object form", () => {
    const r = parseArgs(["fill_form", '{"elements":[{"uid":"u1","value":"hi"}]}']);
    expect(r.toolName).toBe("fill_form");
    expect((r.params as any).elements).toHaveLength(1);
  });

  it("falls back to flag parsing if JSON is invalid", () => {
    const r = parseArgs(["navigate_page", "{bad json}", "--url", "https://x.com"]);
    expect(r.params.url).toBe("https://x.com");
  });

  it("parses multiple flags", () => {
    const r = parseArgs(["click", "--uid", "btn-1", "--dblClick", "true"]);
    expect(r.params).toEqual({ uid: "btn-1", dblClick: true });
  });
});

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

describe("agent identity", () => {
  it("returns error when agentName is unknown", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["take_snapshot"], undefined, {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("agent identity unknown");
    expect(pm.spawnCount).toBe(0);
  });

  it("proceeds when agentName is set", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(0);
    expect(pm.spawnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No args / usage
// ---------------------------------------------------------------------------

describe("no args", () => {
  it("returns usage when called with empty args", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    const result = await handler([], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
    expect(pm.spawnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --list-tools
// ---------------------------------------------------------------------------

describe("--list-tools", () => {
  it("returns formatted tool list", async () => {
    const pm = makeProcessManager({}, [
      { name: "take_snapshot", description: "Take an a11y snapshot" },
      { name: "navigate_page", description: "Navigate to URL" },
    ]);
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["--list-tools"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("take_snapshot");
    expect(result.output).toContain("navigate_page");
    expect(result.output).toContain("2 tools");
  });

  it("returns message when no tools available", async () => {
    const pm = makeProcessManager({}, []);
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["--list-tools"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No tools");
  });
});

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

describe("permission checks", () => {
  it("blocks tool in denyTools", async () => {
    const pm = makeProcessManager();
    const handler = createHandler(
      { denyTools: ["evaluate_script"] },
      { processManager: pm }
    );
    const result = await handler(["evaluate_script", "--function", "() => 1"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("evaluate_script");
    expect(pm.calls).toHaveLength(0);
  });

  it("blocks tool not in allowTools", async () => {
    const pm = makeProcessManager();
    const handler = createHandler(
      { allowTools: ["take_snapshot", "navigate_page"] },
      { processManager: pm }
    );
    const result = await handler(["evaluate_script", "--function", "() => 1"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(pm.calls).toHaveLength(0);
  });

  it("allows tool in allowTools", async () => {
    const pm = makeProcessManager();
    const handler = createHandler(
      { allowTools: ["take_snapshot"] },
      { processManager: pm }
    );
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(0);
    expect(pm.calls).toHaveLength(1);
  });

  it("deny beats allow", async () => {
    const pm = makeProcessManager();
    const handler = createHandler(
      { allowTools: ["evaluate_script"], denyTools: ["evaluate_script"] },
      { processManager: pm }
    );
    const result = await handler(["evaluate_script"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(pm.calls).toHaveLength(0);
  });

  it("allows all tools when neither allowTools nor denyTools is set", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["evaluate_script", "--function", "() => 1"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(0);
    expect(pm.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

describe("tool invocation", () => {
  it("passes tool name and params to process manager", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    await handler(["navigate_page", "--url", "https://example.com"], undefined, makeSession("coder"));
    expect(pm.calls[0].toolName).toBe("navigate_page");
    expect(pm.calls[0].args.url).toBe("https://example.com");
  });

  it("returns tool output text", async () => {
    const pm = makeProcessManager({
      take_snapshot: {
        content: [{ type: "text", text: "Page: example.com\n- button[42] Submit" }],
        isError: false,
      },
    });
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("example.com");
  });

  it("returns exitCode 1 when MCP result has isError: true", async () => {
    const pm = makeProcessManager({
      navigate_page: {
        content: [{ type: "text", text: "net::ERR_NAME_NOT_RESOLVED" }],
        isError: true,
      },
    });
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["navigate_page", "--url", "https://invalid-domain-xyz.com"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("returns error when process manager throws", async () => {
    const failPm: ProcessManagerLike = {
      async getOrCreate() { throw new Error("npx not found"); },
      killAll() {},
    };
    const handler = createHandler({}, { processManager: failPm });
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("failed to start chrome-devtools-mcp");
    expect(result.output).toContain("npx not found");
  });

  it("returns error and crash message when client is closed mid-call", async () => {
    let closed = false;
    const pm: ProcessManagerLike = {
      async getOrCreate() {
        return {
          client: {
            get isClosed() { return closed; },
            async listTools() { return []; },
            async callTool() {
              closed = true; // simulate crash during call
              throw new Error("process died");
            },
            async initialize() {},
          },
          touch() {},
          kill() {},
        };
      },
      killAll() {},
    };
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("exited unexpectedly");
    expect(result.output).toContain("restarted on your next call");
  });

  it("kills the managed process and returns a clear message when a tool call times out", async () => {
    let killed = false;
    const pm: ProcessManagerLike = {
      async getOrCreate() {
        return {
          client: {
            get isClosed() { return false; },
            async listTools() { return []; },
            async callTool() {
              throw new Error("MCP request 'tools/call' timed out after 5000ms");
            },
            async initialize() {},
          },
          touch() {},
          kill() { killed = true; },
        };
      },
      killAll() {},
    };
    const handler = createHandler({ timeout: 5 }, { processManager: pm });
    const result = await handler(["navigate_page", "--url", "https://example.com"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("terminated");
    expect(result.output).toContain("restarted automatically");
    // The process must have been explicitly killed so Chrome doesn't linger
    expect(killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Screenshot path injection
// ---------------------------------------------------------------------------

describe("screenshot path injection", () => {
  it("injects filePath into take_screenshot params", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    await handler(["take_screenshot"], undefined, makeSession("coder"));
    const args = pm.calls[0].args;
    expect(typeof args.filePath).toBe("string");
    expect(args.filePath as string).toContain("media/inbound");
    expect(args.filePath as string).toContain(".png");
  });

  it("does not override filePath if agent supplies one", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    await handler(["take_screenshot", "--filePath", "/custom/path.png"], undefined, makeSession("coder"));
    expect(pm.calls[0].args.filePath).toBe("/custom/path.png");
  });

  it("output contains sandbox path for screenshot", async () => {
    const pm = makeProcessManager({
      take_screenshot: {
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        isError: false,
      },
    });
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["take_screenshot"], undefined, makeSession("coder"));
    // Should return sandbox path, not host path
    expect(result.output).toContain("/workspace/media/inbound");
    expect(result.output).not.toContain(tmpBeigeDir);
  });

  it("does not inject filePath for non-screenshot tools", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(pm.calls[0].args.filePath).toBeUndefined();
  });

  it("also injects filePath for slim-mode screenshot tool name", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    await handler(["screenshot"], undefined, makeSession("coder"));
    expect(pm.calls[0].args.filePath).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple content items
// ---------------------------------------------------------------------------

describe("multiple content items", () => {
  it("joins multiple text items with separator", async () => {
    const pm = makeProcessManager({
      take_snapshot: {
        content: [
          { type: "text", text: "Part one" },
          { type: "text", text: "Part two" },
        ],
        isError: false,
      },
    });
    const handler = createHandler({}, { processManager: pm });
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.output).toContain("Part one");
    expect(result.output).toContain("Part two");
    expect(result.output).toContain("---");
  });
});

// ---------------------------------------------------------------------------
// Download directory — workspaceDir forwarding
// ---------------------------------------------------------------------------

describe("download directory configuration", () => {
  it("passes workspaceDir to processManager.getOrCreate", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    const session = makeSession("coder");
    await handler(["take_snapshot"], undefined, session);
    expect(pm.lastWorkspaceDir).toBe(session.workspaceDir);
  });

  it("passes workspaceDir on every call", async () => {
    const pm = makeProcessManager();
    const handler = createHandler({}, { processManager: pm });
    const session1 = makeSession("coder");
    const session2 = makeSession("reviewer");
    await handler(["take_snapshot"], undefined, session1);
    expect(pm.lastWorkspaceDir).toBe(session1.workspaceDir);
    await handler(["take_snapshot"], undefined, session2);
    expect(pm.lastWorkspaceDir).toBe(session2.workspaceDir);
  });
});

// ---------------------------------------------------------------------------
// setChromeDownloadPreferences
// ---------------------------------------------------------------------------

describe("setChromeDownloadPreferences", () => {
  it("creates Default/Preferences with download.default_directory", () => {
    const profileDir = join(tmpBeigeDir, "profile");
    mkdirSync(profileDir, { recursive: true });
    const downloadDir = "/workspace/media/inbound";

    setChromeDownloadPreferences(profileDir, downloadDir);

    const prefsPath = join(profileDir, "Default", "Preferences");
    expect(existsSync(prefsPath)).toBe(true);

    const prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
    expect(prefs.download.default_directory).toBe(downloadDir);
    expect(prefs.download.prompt_for_download).toBe(false);
    expect(prefs.savefile.default_directory).toBe(downloadDir);
  });

  it("sets session.restore_on_startup to 1 (new tab)", () => {
    const profileDir = join(tmpBeigeDir, "profile-session");
    setChromeDownloadPreferences(profileDir, "/download/path");
    const prefs = JSON.parse(readFileSync(join(profileDir, "Default", "Preferences"), "utf-8"));
    expect(prefs.session.restore_on_startup).toBe(1);
  });

  it("preserves existing preferences when patching", () => {
    const profileDir = join(tmpBeigeDir, "profile");
    const defaultDir = join(profileDir, "Default");
    mkdirSync(defaultDir, { recursive: true });

    const existing = {
      browser: { show_home_button: true },
      download: { default_directory: "/old/path", some_other_setting: 42 },
      extensions: { ui: { developer_mode: true } },
    };
    writeFileSync(join(defaultDir, "Preferences"), JSON.stringify(existing), "utf-8");

    setChromeDownloadPreferences(profileDir, "/new/path");

    const prefs = JSON.parse(readFileSync(join(defaultDir, "Preferences"), "utf-8"));
    expect(prefs.download.default_directory).toBe("/new/path");
    expect(prefs.download.some_other_setting).toBe(42);
    expect(prefs.browser.show_home_button).toBe(true);
    expect(prefs.extensions.ui.developer_mode).toBe(true);
  });

  it("handles corrupted Preferences file gracefully", () => {
    const profileDir = join(tmpBeigeDir, "profile");
    const defaultDir = join(profileDir, "Default");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, "Preferences"), "not valid json{{{", "utf-8");

    setChromeDownloadPreferences(profileDir, "/download/path");

    const prefs = JSON.parse(readFileSync(join(defaultDir, "Preferences"), "utf-8"));
    expect(prefs.download.default_directory).toBe("/download/path");
  });

  it("creates Default directory if it does not exist", () => {
    const profileDir = join(tmpBeigeDir, "profile-new");
    setChromeDownloadPreferences(profileDir, "/download/path");
    expect(existsSync(join(profileDir, "Default", "Preferences"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findBrowserExecutable
// ---------------------------------------------------------------------------

describe("findBrowserExecutable", () => {
  it("returns the first Chrome path that exists", () => {
    const exists = (p: string) => p === CHROME_PATHS[1]; // beta path
    expect(findBrowserExecutable(true, exists)).toBe(CHROME_PATHS[1]);
  });

  it("returns the first Chromium path when no Chrome exists and fallback is true", () => {
    const exists = (p: string) => p === CHROMIUM_PATHS[0];
    expect(findBrowserExecutable(true, exists)).toBe(CHROMIUM_PATHS[0]);
  });

  it("returns null when no Chrome exists and fallback is false", () => {
    const exists = (p: string) => p === CHROMIUM_PATHS[0]; // only Chromium present
    expect(findBrowserExecutable(false, exists)).toBeNull();
  });

  it("returns null when nothing exists", () => {
    const exists = () => false;
    expect(findBrowserExecutable(true, exists)).toBeNull();
    expect(findBrowserExecutable(false, exists)).toBeNull();
  });

  it("prefers Chrome over Chromium when both exist", () => {
    // Both the first Chrome path and the first Chromium path are present
    const exists = (p: string) =>
      p === CHROME_PATHS[0] || p === CHROMIUM_PATHS[0];
    expect(findBrowserExecutable(true, exists)).toBe(CHROME_PATHS[0]);
  });

  it("returns last Chromium path if it is the only one present", () => {
    const last = CHROMIUM_PATHS[CHROMIUM_PATHS.length - 1];
    const exists = (p: string) => p === last;
    expect(findBrowserExecutable(true, exists)).toBe(last);
  });
});

// ---------------------------------------------------------------------------
// buildMcpArgs — executable path resolution
// ---------------------------------------------------------------------------

/** Minimal valid ProcessConfig for buildMcpArgs tests. */
function makeConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
  return {
    beigeDataDir: "/beige",
    version: "latest",
    slim: false,
    headless: false,
    acceptInsecureCerts: false,
    noUsageStatistics: true,
    idleTimeoutMs: 30_000,
    fallbackToChromium: true,
    ...overrides,
  };
}

describe("buildMcpArgs — executable path", () => {
  it("includes --executable-path when executablePath is set explicitly", () => {
    const args = buildMcpArgs(
      makeConfig({ executablePath: "/custom/chrome" }),
      "/profile",
      () => false
    );
    expect(args).toContain("--executablePath=/custom/chrome");
  });

  it("includes --executable-path when auto-detected Chrome is found", () => {
    const exists = (p: string) => p === CHROME_PATHS[0];
    const args = buildMcpArgs(makeConfig(), "/profile", exists);
    expect(args).toContain(`--executablePath=${CHROME_PATHS[0]}`);
  });

  it("includes Chromium --executable-path when Chrome not found but fallback enabled", () => {
    const exists = (p: string) => p === CHROMIUM_PATHS[1];
    const args = buildMcpArgs(makeConfig({ fallbackToChromium: true }), "/profile", exists);
    expect(args).toContain(`--executablePath=${CHROMIUM_PATHS[1]}`);
  });

  it("omits --executable-path when nothing is found", () => {
    const args = buildMcpArgs(makeConfig(), "/profile", () => false);
    expect(args.some((a) => a.startsWith("--executablePath"))).toBe(false);
  });

  it("explicit executablePath beats auto-detection", () => {
    // Both a real Chrome path exists AND executablePath is configured
    const exists = (p: string) => p === CHROME_PATHS[0];
    const args = buildMcpArgs(
      makeConfig({ executablePath: "/pinned/chrome" }),
      "/profile",
      exists
    );
    expect(args).toContain("--executablePath=/pinned/chrome");
    expect(args).not.toContain(`--executablePath=${CHROME_PATHS[0]}`);
  });

  it("always includes --user-data-dir", () => {
    const args = buildMcpArgs(makeConfig(), "/my/profile", () => false);
    expect(args).toContain("--user-data-dir=/my/profile");
  });
});

describe("buildMcpArgs — other flags", () => {
  it("adds --slim when slim is true", () => {
    const args = buildMcpArgs(makeConfig({ slim: true }), "/p", () => false);
    expect(args).toContain("--slim");
  });

  it("adds --headless when headless is true", () => {
    const args = buildMcpArgs(makeConfig({ headless: true }), "/p", () => false);
    expect(args).toContain("--headless");
  });

});

// ---------------------------------------------------------------------------
// display config — forwarded through createHandler → ProcessManager env
// ---------------------------------------------------------------------------

describe("display config", () => {
  it("error message mentions executablePath when browser start fails", async () => {
    const failPm: ProcessManagerLike = {
      async getOrCreate() { throw new Error("ENOENT chrome"); },
      killAll() {},
    };
    const handler = createHandler({}, { processManager: failPm });
    const result = await handler(["take_snapshot"], undefined, makeSession("coder"));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("executablePath");
    expect(result.output).toContain("Chrome or Chromium");
  });
});
