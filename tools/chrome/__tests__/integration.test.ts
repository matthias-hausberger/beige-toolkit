/**
 * Integration tests for the chrome tool.
 *
 * Covers manifest validity and end-to-end flows with stubbed process managers.
 * No real chrome-devtools-mcp process is spawned.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadToolManifest } from "../../../test-utils/loadToolkitManifest.js";
import { assertValidToolManifest } from "../../../test-utils/assertions.js";
import { createHandler, type ProcessManagerLike } from "../index.js";
import type { ManagedProcess } from "../process-manager.js";
import type { McpToolCallResult, McpTool } from "../mcp-client.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("tool manifest", () => {
  const manifest = loadToolManifest("tools/chrome");

  it("is valid", () => {
    assertValidToolManifest(manifest);
  });

  it("has name chrome", () => {
    expect(manifest.name).toBe("chrome");
  });

  it("target is gateway", () => {
    expect(manifest.target).toBe("gateway");
  });

  it("lists at least one command example", () => {
    expect(manifest.commands?.length).toBeGreaterThan(0);
  });

  it("commands include screenshot and navigation", () => {
    const cmds = manifest.commands?.join(" ") ?? "";
    expect(cmds).toContain("screenshot");
    expect(cmds).toContain("navigate");
  });
});

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "chrome-integration-"));
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

function makeManager(
  toolResults: Record<string, McpToolCallResult> = {},
  tools: McpTool[] = []
): ProcessManagerLike & { calls: Array<{ toolName: string; args: Record<string, unknown> }> } {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const client = {
    isClosed: false,
    async listTools() { return tools; },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ toolName: name, args });
      return toolResults[name] ?? {
        content: [{ type: "text" as const, text: `ok:${name}` }],
        isError: false,
      };
    },
    async initialize() {},
  };
  const managed: ManagedProcess = { client, touch() {}, kill() {} };
  return {
    calls,
    async getOrCreate() { return managed; },
    killAll() {},
  };
}

const SESSION = { agentName: "coder" };

// ---------------------------------------------------------------------------
// Full navigation + snapshot flow
// ---------------------------------------------------------------------------

describe("navigation + snapshot flow", () => {
  it("navigates then snapshots in sequence", async () => {
    const pm = makeManager({
      navigate_page: { content: [{ type: "text", text: "Navigated to https://example.com" }], isError: false },
      take_snapshot: { content: [{ type: "text", text: "- heading[1] Example Domain" }], isError: false },
    });
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });

    const nav = await handler(["navigate_page", "--url", "https://example.com"], undefined, SESSION);
    expect(nav.exitCode).toBe(0);
    expect(nav.output).toContain("Navigated");

    const snap = await handler(["take_snapshot"], undefined, SESSION);
    expect(snap.exitCode).toBe(0);
    expect(snap.output).toContain("Example Domain");

    expect(pm.calls).toHaveLength(2);
    expect(pm.calls[0].toolName).toBe("navigate_page");
    expect(pm.calls[1].toolName).toBe("take_snapshot");
  });
});

// ---------------------------------------------------------------------------
// Screenshot creates directory
// ---------------------------------------------------------------------------

describe("screenshot", () => {
  it("creates media/inbound directory if it does not exist", async () => {
    const pm = makeManager();
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });
    await handler(["take_screenshot"], undefined, SESSION);
    expect(existsSync(join(tmpDir, "media", "inbound"))).toBe(true);
  });

  it("take_screenshot call includes a filePath under media/inbound", async () => {
    const pm = makeManager();
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });
    await handler(["take_screenshot"], undefined, SESSION);
    const filePath = pm.calls[0].args.filePath as string;
    expect(filePath).toContain(join("media", "inbound"));
    expect(filePath.endsWith(".png")).toBe(true);
  });

  it("each screenshot call gets a unique filename", async () => {
    const pm = makeManager();
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });
    await handler(["take_screenshot"], undefined, SESSION);
    await new Promise((r) => setTimeout(r, 5)); // ensure different timestamp
    await handler(["take_screenshot"], undefined, SESSION);
    const p1 = pm.calls[0].args.filePath as string;
    const p2 = pm.calls[1].args.filePath as string;
    expect(p1).not.toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// Per-agent isolation
// ---------------------------------------------------------------------------

describe("per-agent isolation", () => {
  it("each agent triggers its own getOrCreate call", async () => {
    const spawnLog: string[] = [];
    const pm: ProcessManagerLike = {
      async getOrCreate(agentName) {
        spawnLog.push(agentName);
        return {
          client: {
            isClosed: false,
            async listTools() { return []; },
            async callTool() { return { content: [{ type: "text" as const, text: "ok" }], isError: false }; },
            async initialize() {},
          },
          touch() {},
          kill() {},
        };
      },
      killAll() {},
    };
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });
    await handler(["take_snapshot"], undefined, { agentName: "coder" });
    await handler(["take_snapshot"], undefined, { agentName: "reviewer" });
    expect(spawnLog).toEqual(["coder", "reviewer"]);
  });
});

// ---------------------------------------------------------------------------
// JSON param form
// ---------------------------------------------------------------------------

describe("JSON param form", () => {
  it("passes fill_form elements array correctly", async () => {
    const pm = makeManager();
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });
    const elements = [{ uid: "u1", value: "hello" }, { uid: "u2", value: "world" }];
    await handler(
      ["fill_form", JSON.stringify({ elements })],
      undefined,
      SESSION
    );
    expect(pm.calls[0].toolName).toBe("fill_form");
    expect(pm.calls[0].args.elements).toEqual(elements);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("error propagation", () => {
  it("surfaces MCP isError response as exitCode 1", async () => {
    const pm = makeManager({
      click: {
        content: [{ type: "text", text: "Element uid-99 not found in snapshot" }],
        isError: true,
      },
    });
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });
    const result = await handler(["click", "--uid", "uid-99"], undefined, SESSION);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not found in snapshot");
  });

  it("handles getOrCreate failure gracefully", async () => {
    let attempt = 0;
    const pm: ProcessManagerLike = {
      async getOrCreate() {
        attempt++;
        if (attempt === 1) throw new Error("Chrome launch failed");
        return {
          client: {
            isClosed: false,
            async listTools() { return []; },
            async callTool() { return { content: [{ type: "text" as const, text: "ok" }], isError: false }; },
            async initialize() {},
          },
          touch() {},
          kill() {},
        };
      },
      killAll() {},
    };
    const handler = createHandler({}, { processManager: pm, workspaceDir: tmpDir });

    const first = await handler(["take_snapshot"], undefined, SESSION);
    expect(first.exitCode).toBe(1);
    expect(first.output).toContain("failed to start chrome-devtools-mcp");

    // Second call respawns successfully
    const second = await handler(["take_snapshot"], undefined, SESSION);
    expect(second.exitCode).toBe(0);
  });
});
