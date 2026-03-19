/**
 * Unit tests for the calendar tool handler.
 *
 * All tests use an injected executor stub — no real calendar-cli process is
 * spawned.  Tests are fast and deterministic.
 */

import { describe, it, expect } from "vitest";
import {
  createHandler,
  extractCommandPath,
  checkPermission,
  type ExecResult,
  type Executor,
} from "../index.js";

// ---------------------------------------------------------------------------
// Stub executor
// ---------------------------------------------------------------------------

function makeExecutor(
  result: Partial<ExecResult> = {}
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const executor: Executor & { calls: typeof calls } = Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {
        stdout: result.stdout ?? "[]",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    { calls }
  );
  return executor;
}

function makeNotFoundExecutor(): Executor {
  return async () => ({
    stdout: "",
    stderr: "calendar-cli binary not found at '/path/to/calendar-cli'. Try recompiling or set config.binaryPath.",
    exitCode: 127,
  });
}

// ---------------------------------------------------------------------------
// extractCommandPath
// ---------------------------------------------------------------------------

describe("extractCommandPath", () => {
  it("extracts single-token command", () => {
    expect(extractCommandPath(["calendars"])).toBe("calendars");
  });

  it("extracts two-token command path", () => {
    expect(extractCommandPath(["events", "today"])).toBe("events today");
  });

  it("caps at two tokens even with more args", () => {
    expect(extractCommandPath(["events", "search", "standup"])).toBe(
      "events search"
    );
  });

  it("stops at flag boundary", () => {
    expect(
      extractCommandPath(["events", "search", "--from", "2026-01-01"])
    ).toBe("events search");
  });

  it("stops at first flag for single-token paths", () => {
    expect(extractCommandPath(["events", "--help"])).toBe("events");
  });

  it("returns empty string for flag-only args", () => {
    expect(extractCommandPath(["--help"])).toBe("");
  });

  it("returns empty string for empty args", () => {
    expect(extractCommandPath([])).toBe("");
  });

  it("stops at -- separator", () => {
    expect(extractCommandPath(["events", "--", "today"])).toBe("events");
  });

  it("extracts date subcommand", () => {
    expect(extractCommandPath(["events", "date", "2026-03-20"])).toBe(
      "events date"
    );
  });

  it("extracts range subcommand", () => {
    expect(
      extractCommandPath(["events", "range", "2026-03-18", "2026-03-21"])
    ).toBe("events range");
  });
});

// ---------------------------------------------------------------------------
// checkPermission
// ---------------------------------------------------------------------------

describe("checkPermission — no restrictions", () => {
  it("allows calendars", () => {
    expect(checkPermission("calendars", {}).allowed).toBe(true);
  });

  it("allows events today", () => {
    expect(checkPermission("events today", {}).allowed).toBe(true);
  });

  it("allows events search", () => {
    expect(checkPermission("events search", {}).allowed).toBe(true);
  });

  it("allows events date", () => {
    expect(checkPermission("events date", {}).allowed).toBe(true);
  });

  it("allows events range", () => {
    expect(checkPermission("events range", {}).allowed).toBe(true);
  });
});

describe("checkPermission — deniedCommands", () => {
  it("blocks exact match", () => {
    const r = checkPermission("events search", {
      deniedCommands: "events search",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("events search");
  });

  it("blocks prefix match — 'events' covers all events subcommands", () => {
    expect(
      checkPermission("events today", { deniedCommands: "events" }).allowed
    ).toBe(false);
    expect(
      checkPermission("events search", { deniedCommands: "events" }).allowed
    ).toBe(false);
    expect(
      checkPermission("events date", { deniedCommands: "events" }).allowed
    ).toBe(false);
    expect(
      checkPermission("events range", { deniedCommands: "events" }).allowed
    ).toBe(false);
  });

  it("prefix match does not over-block — 'events search' does not block 'events today'", () => {
    expect(
      checkPermission("events today", { deniedCommands: "events search" })
        .allowed
    ).toBe(true);
    expect(
      checkPermission("events date", { deniedCommands: "events search" })
        .allowed
    ).toBe(true);
  });

  it("accepts array of deniedCommands", () => {
    const config = { deniedCommands: ["events search", "events range"] };
    expect(checkPermission("events search", config).allowed).toBe(false);
    expect(checkPermission("events range", config).allowed).toBe(false);
    expect(checkPermission("events today", config).allowed).toBe(true);
    expect(checkPermission("calendars", config).allowed).toBe(true);
  });

  it("deny beats allow", () => {
    const config = {
      allowedCommands: ["events search"],
      deniedCommands: ["events search"],
    };
    expect(checkPermission("events search", config).allowed).toBe(false);
  });
});

describe("checkPermission — allowedCommands", () => {
  it("allows command in allowlist", () => {
    const r = checkPermission("events today", {
      allowedCommands: ["events today"],
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks command not in allowlist", () => {
    const r = checkPermission("events search", {
      allowedCommands: ["events today"],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not in allowedCommands");
    expect(r.reason).toContain("events today");
  });

  it("prefix allowlist entry covers subcommands", () => {
    const config = { allowedCommands: "events" };
    expect(checkPermission("events today", config).allowed).toBe(true);
    expect(checkPermission("events search", config).allowed).toBe(true);
    expect(checkPermission("events date", config).allowed).toBe(true);
    expect(checkPermission("calendars", config).allowed).toBe(false);
  });

  it("empty allowedCommands (omitted) allows everything", () => {
    expect(checkPermission("events search", {}).allowed).toBe(true);
    expect(checkPermission("calendars", {}).allowed).toBe(true);
  });

  it("case-insensitive matching", () => {
    expect(
      checkPermission("Events Search", { deniedCommands: "events search" })
        .allowed
    ).toBe(false);
    expect(
      checkPermission("Calendars", { allowedCommands: "calendars" }).allowed
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler — no args
// ---------------------------------------------------------------------------

describe("handler — no args", () => {
  it("returns usage when called with empty args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Handler — permission enforcement
// ---------------------------------------------------------------------------

describe("handler — permission enforcement", () => {
  it("blocks denied command and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { deniedCommands: "events search" },
      { executor: exec }
    );
    const result = await handler(["events", "search", "standup"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("events search");
    expect(exec.calls).toHaveLength(0);
  });

  it("blocks command not in allowlist and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { allowedCommands: ["events today"] },
      { executor: exec }
    );
    const result = await handler(["calendars"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows permitted command and invokes executor", async () => {
    const exec = makeExecutor({ stdout: '[{"title":"Meeting"}]', exitCode: 0 });
    const handler = createHandler(
      { allowedCommands: ["events today", "calendars"] },
      { executor: exec }
    );
    const result = await handler(["events", "today"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Meeting");
    expect(exec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Handler — executor invocation
// ---------------------------------------------------------------------------

describe("handler — executor invocation", () => {
  it("passes args through to calendar-cli unchanged", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["events", "date", "2026-03-20"]);
    expect(exec.calls[0].args).toEqual(["events", "date", "2026-03-20"]);
  });

  it("passes search args through correctly", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler([
      "events",
      "search",
      "standup",
      "--from",
      "2026-03-01",
      "--to",
      "2026-03-31",
    ]);
    expect(exec.calls[0].args).toEqual([
      "events",
      "search",
      "standup",
      "--from",
      "2026-03-01",
      "--to",
      "2026-03-31",
    ]);
  });

  it("passes range args through correctly", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["events", "range", "2026-03-18", "2026-03-21"]);
    expect(exec.calls[0].args).toEqual([
      "events",
      "range",
      "2026-03-18",
      "2026-03-21",
    ]);
  });

  it("passes exit code from calendar-cli through", async () => {
    const exec = makeExecutor({
      stdout: "",
      stderr: '{"error":"Invalid date format"}',
      exitCode: 1,
    });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "date", "bad-date"]);
    expect(result.exitCode).toBe(1);
  });

  it("returns stdout on success", async () => {
    const exec = makeExecutor({
      stdout: '[{"title":"Standup","start":"2026-03-19T09:00:00"}]',
      exitCode: 0,
    });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "today"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Standup");
  });

  it("returns (no output) when both stdout and stderr are empty", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "today"]);
    expect(result.output).toBe("(no output)");
  });

  it("combines stdout and stderr in output", async () => {
    const exec = makeExecutor({
      stdout: "[]",
      stderr: "some warning",
      exitCode: 0,
    });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "today"]);
    expect(result.output).toContain("[]");
    expect(result.output).toContain("some warning");
  });

  it("surfaces binary-not-found error clearly", async () => {
    const handler = createHandler({}, { executor: makeNotFoundExecutor() });
    const result = await handler(["calendars"]);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Handler — timeout config
// ---------------------------------------------------------------------------

describe("handler — timeout config", () => {
  it("uses default timeout of 10 seconds", async () => {
    let capturedTimeout = 0;
    const exec: Executor = async (_cmd, _args, timeoutMs) => {
      capturedTimeout = timeoutMs;
      return { stdout: "[]", stderr: "", exitCode: 0 };
    };
    const handler = createHandler({}, { executor: exec });
    await handler(["calendars"]);
    expect(capturedTimeout).toBe(10_000);
  });

  it("respects custom timeout from config", async () => {
    let capturedTimeout = 0;
    const exec: Executor = async (_cmd, _args, timeoutMs) => {
      capturedTimeout = timeoutMs;
      return { stdout: "[]", stderr: "", exitCode: 0 };
    };
    const handler = createHandler({ timeout: 30 }, { executor: exec });
    await handler(["calendars"]);
    expect(capturedTimeout).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Handler — binary path config
// ---------------------------------------------------------------------------

describe("handler — binary path", () => {
  it("uses configured binaryPath when provided", async () => {
    let capturedCmd = "";
    const exec: Executor = async (cmd, _args, _timeoutMs) => {
      capturedCmd = cmd;
      return { stdout: "[]", stderr: "", exitCode: 0 };
    };
    const handler = createHandler(
      { binaryPath: "/custom/path/calendar-cli" },
      { executor: exec }
    );
    await handler(["calendars"]);
    expect(capturedCmd).toBe("/custom/path/calendar-cli");
  });
});

// ---------------------------------------------------------------------------
// Handler — createHandler returns a function
// ---------------------------------------------------------------------------

describe("createHandler", () => {
  it("returns a callable function", () => {
    const handler = createHandler({}, { executor: makeExecutor() });
    expect(typeof handler).toBe("function");
  });

  it("accepts an empty config object", () => {
    expect(() => createHandler({}, { executor: makeExecutor() })).not.toThrow();
  });

  it("accepts allowedCommands and deniedCommands config", () => {
    expect(() =>
      createHandler(
        { allowedCommands: ["calendars"], deniedCommands: ["events search"] },
        { executor: makeExecutor() }
      )
    ).not.toThrow();
  });
});
