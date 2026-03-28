/**
 * Unit tests for the Brave Search plugin.
 *
 * These tests cover argument parsing, error handling, and output formatting.
 * Network calls are avoided — the real API is not hit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPlugin } from "../index.ts";

// ── Minimal PluginContext mock ────────────────────────────────────────────────

function makeMockCtx() {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

// ── Capture the registered tool handler ──────────────────────────────────────

function getHandler(config: Record<string, unknown> = {}) {
  const ctx = makeMockCtx();
  const plugin = createPlugin(config, ctx as any);

  let capturedHandler: (args: string[]) => Promise<{ output: string; exitCode: number }>;

  plugin.register({
    tool(def: any) {
      capturedHandler = def.handler;
    },
  } as any);

  return { handler: capturedHandler!, ctx };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createPlugin", () => {
  it("returns an object with register, start and stop", () => {
    const ctx = makeMockCtx();
    const plugin = createPlugin({ apiKey: "test" }, ctx as any);
    expect(typeof plugin.register).toBe("function");
    expect(typeof plugin.start).toBe("function");
    expect(typeof plugin.stop).toBe("function");
  });

  it("registers a tool named 'brave'", () => {
    const ctx = makeMockCtx();
    const plugin = createPlugin({ apiKey: "test" }, ctx as any);
    const reg = { tool: vi.fn() };
    plugin.register(reg as any);
    expect(reg.tool).toHaveBeenCalledOnce();
    expect(reg.tool.mock.calls[0][0].name).toBe("brave");
  });

  it("warns when no API key is provided", () => {
    const ctx = makeMockCtx();
    createPlugin({}, ctx as any);
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining("no API key"));
  });
});

describe("handler argument parsing", () => {
  it("returns usage when called with no args", async () => {
    const { handler } = getHandler({ apiKey: "k" });
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("returns usage when first arg is not 'search'", async () => {
    const { handler } = getHandler({ apiKey: "k" });
    const result = await handler(["unknown"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("returns error when no API key is configured", async () => {
    const { handler } = getHandler({});
    const result = await handler(["search", "hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("API key not configured");
  });

  it("returns error when query is empty after flags", async () => {
    const { handler } = getHandler({ apiKey: "k" });
    const result = await handler(["search", "--count", "3"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("query cannot be empty");
  });

  it("returns error for invalid --count value", async () => {
    const { handler } = getHandler({ apiKey: "k" });
    const result = await handler(["search", "test", "--count", "bad"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--count must be a positive integer");
  });

  it("returns error for negative --offset value", async () => {
    const { handler } = getHandler({ apiKey: "k" });
    const result = await handler(["search", "test", "--offset", "-1"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--offset must be a non-negative integer");
  });

  it("returns error when --country has no value", async () => {
    const { handler } = getHandler({ apiKey: "k" });
    const result = await handler(["search", "test", "--country"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--country requires a value");
  });
});

describe("formatResults (via mocked fetch)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a no-results message when API returns empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      })
    );

    const { handler } = getHandler({ apiKey: "test-key" });
    const result = await handler(["search", "something obscure"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No results found");
  });

  it("formats results with title, url, and description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "Example Site",
                url: "https://example.com",
                description: "An example website.",
                age: "2 days ago",
              },
            ],
          },
        }),
      })
    );

    const { handler } = getHandler({ apiKey: "test-key" });
    const result = await handler(["search", "example"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Example Site");
    expect(result.output).toContain("https://example.com");
    expect(result.output).toContain("An example website.");
    expect(result.output).toContain("2 days ago");
  });

  it("truncates long descriptions to 200 chars", async () => {
    const longDesc = "x".repeat(300);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          web: { results: [{ title: "T", url: "https://t.com", description: longDesc }] },
        }),
      })
    );

    const { handler } = getHandler({ apiKey: "test-key" });
    const result = await handler(["search", "test"]);
    expect(result.exitCode).toBe(0);
    // Should be truncated — 197 x chars + "…" = 200 chars visible
    expect(result.output).toContain("…");
    expect(result.output).not.toContain(longDesc);
  });

  it("surfaces API error messages cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid token",
      })
    );

    const { handler } = getHandler({ apiKey: "bad-key" });
    const result = await handler(["search", "test"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Search failed");
    expect(result.output).toContain("401");
  });

  it("passes --count to the API query string", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: async () => ({ web: { results: [] } }),
        });
      })
    );

    const { handler } = getHandler({ apiKey: "k" });
    await handler(["search", "hello", "--count", "3"]);
    expect(capturedUrl).toContain("count=3");
  });

  it("passes --country uppercased to the API query string", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: async () => ({ web: { results: [] } }),
        });
      })
    );

    const { handler } = getHandler({ apiKey: "k" });
    await handler(["search", "hello", "--country", "de"]);
    expect(capturedUrl).toContain("country=DE");
  });
});
