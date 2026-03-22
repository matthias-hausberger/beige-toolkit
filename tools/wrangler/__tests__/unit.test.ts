import { describe, it, expect } from "vitest";
import {
  extractCommandPath,
  checkPermission,
  resolveWranglerPath,
  createHandler,
  WranglerConfig,
  ExecResult,
} from "../index.js";

// ---------------------------------------------------------------------------
// extractCommandPath tests
// ---------------------------------------------------------------------------

describe("extractCommandPath", () => {
  it("extracts single command", () => {
    expect(extractCommandPath(["deploy"])).toBe("deploy");
  });

  it("extracts multi-level command path", () => {
    expect(extractCommandPath(["d1", "database", "create", "mydb", "--remote"])).toBe(
      "d1 database create mydb"
    );
  });

  it("stops at flag with single dash", () => {
    expect(extractCommandPath(["d1", "database", "list", "--limit", "10"])).toBe(
      "d1 database list"
    );
  });

  it("stops at flag with double dash", () => {
    expect(extractCommandPath(["kv", "key", "get", "--namespace-id", "abc", "mykey"])).toBe(
      "kv key get"
    );
  });

  it("stops at -- separator", () => {
    expect(extractCommandPath(["pages", "deploy", "--", "./dist"])).toBe("pages deploy");
  });

  it("returns empty string for flags-only args", () => {
    expect(extractCommandPath(["--help"])).toBe("");
  });

  it("returns empty string for empty args", () => {
    expect(extractCommandPath([])).toBe("");
  });

  it("handles pages project command", () => {
    expect(extractCommandPath(["pages", "project", "list"])).toBe("pages project list");
  });

  it("handles r2 bucket commands", () => {
    expect(extractCommandPath(["r2", "bucket", "create", "mybucket"])).toBe(
      "r2 bucket create mybucket"
    );
  });
});

// ---------------------------------------------------------------------------
// checkPermission tests
// ---------------------------------------------------------------------------

describe("checkPermission", () => {
  const baseConfig: WranglerConfig = { apiToken: "test-token" };

  it("allows all commands when no allow/deny configured", () => {
    const result = checkPermission("d1 database destroy", baseConfig);
    expect(result.allowed).toBe(true);
  });

  it("blocks command in denyCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      denyCommands: ["d1 database destroy"],
    };
    const result = checkPermission("d1 database destroy", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked by denyCommands");
  });

  it("blocks command via prefix match in denyCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      denyCommands: ["d1"],
    };
    expect(checkPermission("d1 database list", config).allowed).toBe(false);
    expect(checkPermission("d1 database destroy", config).allowed).toBe(false);
    expect(checkPermission("d1 execute", config).allowed).toBe(false);
  });

  it("allows command not in denyCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      denyCommands: ["d1 database destroy"],
    };
    expect(checkPermission("d1 database list", config).allowed).toBe(true);
    expect(checkPermission("deploy", config).allowed).toBe(true);
  });

  it("blocks command not in allowCommands when allowCommands is set", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      allowCommands: ["deploy", "tail"],
    };
    const result = checkPermission("d1 database list", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in allowCommands");
  });

  it("allows command in allowCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      allowCommands: ["deploy", "tail"],
    };
    expect(checkPermission("deploy", config).allowed).toBe(true);
    expect(checkPermission("tail", config).allowed).toBe(true);
  });

  it("allows command via prefix match in allowCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      allowCommands: ["d1"],
    };
    expect(checkPermission("d1 database list", config).allowed).toBe(true);
    expect(checkPermission("d1 database create", config).allowed).toBe(true);
    expect(checkPermission("d1 execute", config).allowed).toBe(true);
  });

  it("deny beats allow", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      allowCommands: ["d1"],
      denyCommands: ["d1 database destroy"],
    };
    expect(checkPermission("d1 database list", config).allowed).toBe(true);
    expect(checkPermission("d1 database destroy", config).allowed).toBe(false);
  });

  it("handles array of commands in allowCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      allowCommands: ["deploy", "tail", "d1 database list"],
    };
    expect(checkPermission("deploy", config).allowed).toBe(true);
    expect(checkPermission("d1 database list", config).allowed).toBe(true);
    expect(checkPermission("d1 database create", config).allowed).toBe(false);
  });

  it("handles string command (single) in allowCommands", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      allowCommands: "deploy",
    };
    expect(checkPermission("deploy", config).allowed).toBe(true);
    expect(checkPermission("tail", config).allowed).toBe(false);
  });

  it("case-insensitive matching", () => {
    const config: WranglerConfig = {
      ...baseConfig,
      denyCommands: ["D1 DATABASE DESTROY"],
    };
    expect(checkPermission("d1 database destroy", config).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveWranglerPath tests
// ---------------------------------------------------------------------------

describe("resolveWranglerPath", () => {
  it("returns configured path if provided and exists", () => {
    // This test would need fs mocking or a real file
    // For now, test the null case
    const result = resolveWranglerPath("/nonexistent/path/to/wrangler");
    expect(result).toBeNull();
  });

  it("returns 'wrangler' as fallback for PATH resolution", () => {
    // When no local install and no configured path
    const result = resolveWranglerPath();
    // Could be "wrangler" (fallback) or a local path if one exists
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// createHandler tests
// ---------------------------------------------------------------------------

describe("createHandler", () => {
  const mockExecutor = async (
    cmd: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<ExecResult> => {
    return { stdout: `mock: ${cmd} ${args.join(" ")}`, stderr: "", exitCode: 0 };
  };

  const mockPathResolver = () => "/usr/local/bin/wrangler";

  it("returns error when apiToken is missing", async () => {
    const handler = createHandler({}, { executor: mockExecutor, resolveWranglerPath: mockPathResolver });
    const result = await handler(["deploy"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("apiToken is required");
  });

  it("returns usage when no args provided", async () => {
    const handler = createHandler(
      { apiToken: "test-token" },
      { executor: mockExecutor, resolveWranglerPath: mockPathResolver }
    );
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("executes command when permitted", async () => {
    const handler = createHandler(
      { apiToken: "test-token" },
      { executor: mockExecutor, resolveWranglerPath: mockPathResolver }
    );
    const result = await handler(["deploy"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("mock:");
  });

  it("blocks command in denyCommands", async () => {
    const handler = createHandler(
      { apiToken: "test-token", denyCommands: ["deploy"] },
      { executor: mockExecutor, resolveWranglerPath: mockPathResolver }
    );
    const result = await handler(["deploy"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("blocks command not in allowCommands", async () => {
    const handler = createHandler(
      { apiToken: "test-token", allowCommands: ["tail"] },
      { executor: mockExecutor, resolveWranglerPath: mockPathResolver }
    );
    const result = await handler(["deploy"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not in allowCommands");
  });

  it("allows flags-only args (e.g., --help)", async () => {
    const handler = createHandler(
      { apiToken: "test-token", allowCommands: ["deploy"] },
      { executor: mockExecutor, resolveWranglerPath: mockPathResolver }
    );
    const result = await handler(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("mock:");
  });

  it("injects auth environment variables", async () => {
    let capturedEnv: Record<string, string> = {};
    const capturingExecutor = async (
      cmd: string,
      args: string[],
      env: Record<string, string>,
      timeoutMs: number
    ): Promise<ExecResult> => {
      capturedEnv = env;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createHandler(
      { apiToken: "my-token", accountId: "my-account" },
      { executor: capturingExecutor, resolveWranglerPath: mockPathResolver }
    );
    await handler(["deploy"]);

    expect(capturedEnv.CLOUDFLARE_API_TOKEN).toBe("my-token");
    expect(capturedEnv.CLOUDFLARE_ACCOUNT_ID).toBe("my-account");
  });

  it("omits accountId env var when not configured", async () => {
    let capturedEnv: Record<string, string> = {};
    const capturingExecutor = async (
      cmd: string,
      args: string[],
      env: Record<string, string>,
      timeoutMs: number
    ): Promise<ExecResult> => {
      capturedEnv = env;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createHandler(
      { apiToken: "my-token" },
      { executor: capturingExecutor, resolveWranglerPath: mockPathResolver }
    );
    await handler(["deploy"]);

    expect(capturedEnv.CLOUDFLARE_API_TOKEN).toBe("my-token");
    expect(capturedEnv.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });

  it("returns error when wrangler binary not found", async () => {
    const nullPathResolver = () => null;
    const handler = createHandler(
      { apiToken: "test-token" },
      { executor: mockExecutor, resolveWranglerPath: nullPathResolver }
    );
    const result = await handler(["deploy"]);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("wrangler not found");
  });

  it("uses custom timeout from config", async () => {
    let capturedTimeout = 0;
    const timeoutCapturingExecutor = async (
      cmd: string,
      args: string[],
      env: Record<string, string>,
      timeoutMs: number
    ): Promise<ExecResult> => {
      capturedTimeout = timeoutMs;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createHandler(
      { apiToken: "test-token", timeout: 300 },
      { executor: timeoutCapturingExecutor, resolveWranglerPath: mockPathResolver }
    );
    await handler(["deploy"]);

    expect(capturedTimeout).toBe(300 * 1000);
  });

  it("uses default timeout of 180s when not configured", async () => {
    let capturedTimeout = 0;
    const timeoutCapturingExecutor = async (
      cmd: string,
      args: string[],
      env: Record<string, string>,
      timeoutMs: number
    ): Promise<ExecResult> => {
      capturedTimeout = timeoutMs;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createHandler(
      { apiToken: "test-token" },
      { executor: timeoutCapturingExecutor, resolveWranglerPath: mockPathResolver }
    );
    await handler(["deploy"]);

    expect(capturedTimeout).toBe(180 * 1000);
  });
});
