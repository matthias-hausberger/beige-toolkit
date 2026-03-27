/**
 * Unit tests for the schedule tool.
 *
 * All tests use injected stubs — no real filesystem, clock, prompt, or exec
 * calls are made.  Tests are deterministic and run in milliseconds.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseArgs,
  createHandler,
  createTickFn,
  getNextCronRun,
  validateCronExpression,
  type ScheduleEntry,
  type ScheduleDeps,
  type ScheduleConfig,
  type RunRecord,
  type ActionExec,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Stub builders
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory fake filesystem */
function makeFakeFs(initial: Record<string, string> = {}): Required<ScheduleDeps>["fs"] & { store: Record<string, string> } {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    writeFile(path, content) { store[path] = content; },
    readFile(path) {
      if (!(path in store)) throw new Error(`ENOENT: ${path}`);
      return store[path];
    },
    readDir(path) {
      const prefix = path.endsWith("/") ? path : path + "/";
      return Object.keys(store)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length).split("/")[0])
        .filter((v, i, a) => a.indexOf(v) === i); // unique
    },
    exists(path) { return path in store || Object.keys(store).some((k) => k.startsWith(path + "/")); },
    ensureDir(_path) { /* no-op for in-memory */ },
    atomicWrite(path, content) { store[path] = content; },
  };
}

function makeDeps(overrides: Partial<ScheduleDeps> = {}): Required<ScheduleDeps> {
  return {
    fs: makeFakeFs(),
    now: () => new Date("2026-03-27T10:00:00Z"),
    promptFn: async (_sessionKey, _agentName, message) => `Response for: ${message}`,
    execInSandbox: async (_agentName, _command) => ({ stdout: "exec ok", stderr: "", exitCode: 0 }),
    generateId: (() => {
      let n = 0;
      return () => `sched_test${++n}`;
    })(),
    ...overrides,
  };
}

const BASE_CFG: ScheduleConfig = {
  storagePath: "/fake/schedule",
  tickInterval: 15,
  // allowExec not set → defaults to true (same as production)
  maxSchedulesPerAgent: 20,
};

const SESSION_CTX = { sessionKey: "sess_abc", agentName: "assistant", channel: "tui" };

// ─────────────────────────────────────────────────────────────────────────────
// parseArgs
// ─────────────────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns null subcommand on empty args", () => {
    const r = parseArgs([]);
    expect(r.subcommand).toBeNull();
  });

  it("returns null subcommand on unknown subcommand", () => {
    const r = parseArgs(["frobulate"]);
    expect(r.subcommand).toBeNull();
  });

  it("parses create --once --prompt", () => {
    const r = parseArgs(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "hello", "world"]);
    expect(r.subcommand).toBe("create");
    if (r.subcommand !== "create") return;
    expect(r.once).toBe("2026-03-28T09:00:00Z");
    expect(r.prompt).toBe("hello world");
  });

  it("parses create --cron --tz --message-file", () => {
    const r = parseArgs(["create", "--cron", "0 9 * * 1-5", "--tz", "Europe/Vienna", "--message-file", "/workspace/brief.md"]);
    expect(r.subcommand).toBe("create");
    if (r.subcommand !== "create") return;
    expect(r.cron).toBe("0 9 * * 1-5");
    expect(r.tz).toBe("Europe/Vienna");
    expect(r.messageFile).toBe("/workspace/brief.md");
  });

  it("parses create --once --exec with optional flags", () => {
    const r = parseArgs([
      "create", "--once", "2026-03-28T09:00:00Z",
      "--exec", "node /workspace/run.mjs",
      "--label", "My job",
      "--max-runs", "5",
      "--expires", "2027-01-01T00:00:00Z",
    ]);
    expect(r.subcommand).toBe("create");
    if (r.subcommand !== "create") return;
    expect(r.exec).toBe("node /workspace/run.mjs");
    expect(r.label).toBe("My job");
    expect(r.maxRuns).toBe(5);
    expect(r.expires).toBe("2027-01-01T00:00:00Z");
  });

  it("parses list with --status and --format", () => {
    const r = parseArgs(["list", "--status", "all", "--format", "json"]);
    expect(r.subcommand).toBe("list");
    if (r.subcommand !== "list") return;
    expect(r.status).toBe("all");
    expect(r.format).toBe("json");
  });

  it("parses get <id>", () => {
    const r = parseArgs(["get", "sched_abc"]);
    expect(r.subcommand).toBe("get");
    if (r.subcommand !== "get") return;
    expect(r.id).toBe("sched_abc");
  });

  it("parses cancel / pause / resume / test with id", () => {
    for (const cmd of ["cancel", "pause", "resume", "test"] as const) {
      const r = parseArgs([cmd, "sched_xyz"]);
      expect(r.subcommand).toBe(cmd);
      if (r.subcommand !== cmd) return;
      expect(r.id).toBe("sched_xyz");
    }
  });

  it("parses history with --limit and --format", () => {
    const r = parseArgs(["history", "sched_abc", "--limit", "10", "--format", "json"]);
    expect(r.subcommand).toBe("history");
    if (r.subcommand !== "history") return;
    expect(r.id).toBe("sched_abc");
    expect(r.limit).toBe(10);
    expect(r.format).toBe("json");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("cron helpers", () => {
  it("validates a good expression", () => {
    expect(validateCronExpression("0 9 * * 1-5", "UTC")).toBeNull();
  });

  it("rejects a bad expression", () => {
    expect(validateCronExpression("not-a-cron", "UTC")).not.toBeNull();
  });

  it("getNextCronRun returns a future date", () => {
    const after = new Date("2026-03-27T10:00:00Z"); // Friday
    const next = getNextCronRun("0 9 * * 1-5", "UTC", after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it("getNextCronRun returns null on invalid expression", () => {
    const next = getNextCronRun("bad expr", "UTC", new Date());
    expect(next).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createHandler — error cases
// ─────────────────────────────────────────────────────────────────────────────

describe("createHandler — no args", () => {
  it("returns usage on empty args", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler([], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage:");
  });
});

describe("createHandler — agent identity", () => {
  it("errors when agentName is missing from session context", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(["list"], undefined, { sessionKey: "sess_x" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("agent identity unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("create — validation", () => {
  it("errors without --once or --cron", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(["create", "--prompt", "hello"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("--once");
  });

  it("errors when --once and --cron are both provided", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(
      ["create", "--once", "2026-03-28T09:00:00Z", "--cron", "0 9 * * *", "--prompt", "hi"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("mutually exclusive");
  });

  it("errors without an action flag", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(["create", "--once", "2026-03-28T09:00:00Z"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("--prompt");
  });

  it("errors when multiple action flags are provided", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(
      ["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "hi", "--exec", "ls"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("mutually exclusive");
  });

  it("errors on past --once datetime", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(
      ["create", "--once", "2020-01-01T00:00:00Z", "--prompt", "hello"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("in the past");
  });

  it("errors on invalid --once datetime", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(
      ["create", "--once", "not-a-date", "--prompt", "hello"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("invalid ISO 8601");
  });

  it("errors on invalid cron expression", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(
      ["create", "--cron", "not-a-cron", "--prompt", "hello"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("invalid cron expression");
  });

  it("errors on exec when allowExec is explicitly false", async () => {
    const handler = createHandler({ ...BASE_CFG, allowExec: false }, makeDeps());
    const r = await handler(
      ["create", "--once", "2026-03-28T09:00:00Z", "--exec", "ls"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("exec actions are disabled");
  });

  it("errors when quota is exceeded", async () => {
    const deps = makeDeps();
    const handler = createHandler({ ...BASE_CFG, maxSchedulesPerAgent: 2 }, deps);

    // Create two schedules to fill the quota
    for (let i = 1; i <= 2; i++) {
      const r = await handler(
        ["create", "--once", `2026-03-2${i + 7}T09:00:00Z`, "--prompt", `msg ${i}`],
        undefined,
        SESSION_CTX
      );
      expect(r.exitCode).toBe(0);
    }

    // Third should fail
    const r = await handler(
      ["create", "--once", "2026-03-30T09:00:00Z", "--prompt", "overflow"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("maximum of 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create — success cases
// ─────────────────────────────────────────────────────────────────────────────

describe("create — success", () => {
  it("creates a one-off prompt schedule and returns SCHEDULED: <id>", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    const r = await handler(
      ["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "Check the build"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^SCHEDULED: sched_test1/);
    expect(r.output).toContain("once at 2026-03-28T09:00:00.000Z");
    expect(r.output).toContain("prompt");
    expect(r.output).toContain("Check the build");
  });

  it("creates a cron message-file schedule", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    const r = await handler(
      ["create", "--cron", "0 9 * * 1-5", "--tz", "Europe/Vienna", "--message-file", "/workspace/brief.md", "--label", "Morning"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^SCHEDULED:/);
    expect(r.output).toContain("Morning");
    expect(r.output).toContain("cron");
    expect(r.output).toContain("message-file");
  });

  it("creates an exec schedule (allowExec defaults to true)", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    const r = await handler(
      ["create", "--once", "2026-03-28T09:00:00Z", "--exec", "node /workspace/run.mjs"],
      undefined,
      SESSION_CTX
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("exec");
    expect(r.output).toContain("node /workspace/run.mjs");
  });

  it("stores createdBy from session context (not caller-supplied)", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(
      ["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "hi"],
      undefined,
      { sessionKey: "sess_q", agentName: "planner" }
    );

    // Find the saved schedule in the fake filesystem
    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const scheduleFile = Object.keys(fs.store).find((k) => k.includes("sched_"));
    expect(scheduleFile).toBeTruthy();
    const saved = JSON.parse(fs.store[scheduleFile!]) as ScheduleEntry;
    expect(saved.createdBy).toBe("planner");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

describe("list", () => {
  it("returns 'No active schedules found' when none exist", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(["list"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("No");
  });

  it("lists only schedules belonging to the calling agent", async () => {
    const deps = makeDeps();

    // Create schedule as "assistant"
    const h1 = createHandler(BASE_CFG, deps);
    await h1(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "a1"], undefined, SESSION_CTX);

    // Create schedule as "other-agent"
    await h1(["create", "--once", "2026-03-28T10:00:00Z", "--prompt", "o1"], undefined, { sessionKey: "sess_other", agentName: "other-agent" });

    // List as "assistant" — should see only their own
    const r = await h1(["list"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    // Only 1 schedule for assistant
    const lines = r.output.split("\n").filter((l) => l.includes("sched_"));
    expect(lines).toHaveLength(1);
  });

  it("returns JSON when --format json", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "hi"], undefined, SESSION_CTX);

    const r = await handler(["list", "--format", "json"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].createdBy).toBe("assistant");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get / cancel / pause / resume
// ─────────────────────────────────────────────────────────────────────────────

describe("get", () => {
  it("returns full schedule detail", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "hello"], undefined, SESSION_CTX);

    const r = await handler(["get", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("sched_test1");
    expect(r.output).toContain("assistant");
  });

  it("errors on unknown id", async () => {
    const handler = createHandler(BASE_CFG, makeDeps());
    const r = await handler(["get", "sched_nope"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("not found");
  });

  it("errors when schedule belongs to a different agent", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "x"], undefined, { sessionKey: "s", agentName: "other" });

    const r = await handler(["get", "sched_test1"], undefined, SESSION_CTX); // SESSION_CTX is "assistant"
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("does not belong");
  });
});

describe("cancel", () => {
  it("cancels an active schedule", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "x"], undefined, SESSION_CTX);

    const r = await handler(["cancel", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("Cancelled");

    // Verify status in storage
    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const key = Object.keys(fs.store).find((k) => k.includes("sched_test1"))!;
    const saved = JSON.parse(fs.store[key]) as ScheduleEntry;
    expect(saved.status).toBe("cancelled");
    expect(saved.nextRun).toBeNull();
  });

  it("is idempotent on already-cancelled schedule", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "x"], undefined, SESSION_CTX);
    await handler(["cancel", "sched_test1"], undefined, SESSION_CTX);

    const r = await handler(["cancel", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("already cancelled");
  });
});

describe("pause / resume", () => {
  it("pauses an active schedule and resumes it", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--cron", "0 9 * * *", "--prompt", "daily"], undefined, SESSION_CTX);

    const pr = await handler(["pause", "sched_test1"], undefined, SESSION_CTX);
    expect(pr.exitCode).toBe(0);
    expect(pr.output).toContain("Paused");

    const rr = await handler(["resume", "sched_test1"], undefined, SESSION_CTX);
    expect(rr.exitCode).toBe(0);
    expect(rr.output).toContain("Resumed");
    expect(rr.output).toContain("Next run:");
  });

  it("errors when pausing a non-active schedule", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--cron", "0 9 * * *", "--prompt", "daily"], undefined, SESSION_CTX);
    await handler(["pause", "sched_test1"], undefined, SESSION_CTX);

    const r = await handler(["pause", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("paused");
  });

  it("errors when resuming a non-paused schedule", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--cron", "0 9 * * *", "--prompt", "daily"], undefined, SESSION_CTX);

    const r = await handler(["resume", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("active"); // says it's not paused
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tick loop
// ─────────────────────────────────────────────────────────────────────────────

describe("tick loop — one-off prompt", () => {
  it("fires a due once-schedule and marks it completed", async () => {
    const prompted: Array<{ sessionKey: string; agentName: string; message: string }> = [];
    const deps = makeDeps({
      promptFn: async (sk, an, msg) => { prompted.push({ sessionKey: sk, agentName: an, message: msg }); return "ok"; },
      // Clock starts BEFORE the schedule
      now: (() => {
        let call = 0;
        return () => call++ === 0
          ? new Date("2026-03-27T10:00:00Z")   // create time (schedule at 11:00)
          : new Date("2026-03-27T11:01:00Z");   // tick time (after due)
      })(),
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-27T11:00:00Z", "--prompt", "wake up"], undefined, SESSION_CTX);

    // Run tick (now returns 11:01 → schedule is due)
    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    // Prompt was called with the scheduling agent
    expect(prompted).toHaveLength(1);
    expect(prompted[0].agentName).toBe("assistant");
    expect(prompted[0].message).toBe("wake up");

    // Schedule is now completed
    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const key = Object.keys(fs.store).find((k) => k.includes("sched_test1.json"))!;
    const saved = JSON.parse(fs.store[key]) as ScheduleEntry;
    expect(saved.status).toBe("completed");
    expect(saved.runCount).toBe(1);
    expect(saved.nextRun).toBeNull();
  });

  it("does not fire a schedule that is not yet due", async () => {
    const prompted: string[] = [];
    const deps = makeDeps({
      promptFn: async (_, __, msg) => { prompted.push(msg); return "ok"; },
      now: () => new Date("2026-03-27T08:00:00Z"), // before the schedule
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-27T11:00:00Z", "--prompt", "future"], undefined, SESSION_CTX);

    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    expect(prompted).toHaveLength(0);
  });
});

describe("tick loop — cron", () => {
  it("fires a cron schedule and advances nextRun", async () => {
    const prompted: string[] = [];

    // Schedule is "every minute" so it's always due
    // now() always returns same time so first call is creation, second is tick
    let call = 0;
    const deps = makeDeps({
      promptFn: async (_, __, msg) => { prompted.push(msg); return "ok"; },
      now: () => {
        call++;
        if (call === 1) return new Date("2026-03-27T10:00:00Z"); // creation
        return new Date("2026-03-27T10:01:30Z"); // tick — after nextRun
      },
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--cron", "* * * * *", "--prompt", "tick tock"], undefined, SESSION_CTX);

    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    expect(prompted).toHaveLength(1);

    // Status should still be active (cron never completes unless maxRuns/expiresAt)
    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const key = Object.keys(fs.store).find((k) => k.includes("sched_test1.json"))!;
    const saved = JSON.parse(fs.store[key]) as ScheduleEntry;
    expect(saved.status).toBe("active");
    expect(saved.runCount).toBe(1);
    expect(saved.nextRun).not.toBeNull();
  });

  it("completes a cron schedule after maxRuns is reached", async () => {
    let call = 0;
    const deps = makeDeps({
      promptFn: async () => "ok",
      now: () => {
        call++;
        if (call === 1) return new Date("2026-03-27T10:00:00Z");
        return new Date("2026-03-27T10:05:00Z");
      },
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--cron", "* * * * *", "--prompt", "one-time cron", "--max-runs", "1"], undefined, SESSION_CTX);

    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const key = Object.keys(fs.store).find((k) => k.includes("sched_test1.json"))!;
    const saved = JSON.parse(fs.store[key]) as ScheduleEntry;
    expect(saved.status).toBe("completed");
    expect(saved.nextRun).toBeNull();
  });
});

describe("tick loop — exec", () => {
  it("calls execInSandbox directly (no LLM) for exec actions", async () => {
    const sandboxCalls: Array<{ agentName: string; command: string }> = [];
    const promptCalls: string[] = [];
    let call = 0;
    const deps = makeDeps({
      execInSandbox: async (agentName, command) => {
        sandboxCalls.push({ agentName, command });
        return { stdout: "done", stderr: "", exitCode: 0 };
      },
      promptFn: async (_sk, _an, msg) => { promptCalls.push(msg); return "ok"; },
      now: () => {
        call++;
        return call === 1
          ? new Date("2026-03-27T10:00:00Z")
          : new Date("2026-03-27T11:01:00Z");
      },
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-27T11:00:00Z", "--exec", "node /workspace/job.mjs"], undefined, SESSION_CTX);

    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    // execInSandbox was called — not promptFn
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0].agentName).toBe("assistant");
    expect(sandboxCalls[0].command).toBe("node /workspace/job.mjs");
    expect(promptCalls).toHaveLength(0); // LLM was NOT invoked
  });

  it("records error when the sandbox command exits non-zero", async () => {
    let call = 0;
    const deps = makeDeps({
      execInSandbox: async () => ({ stdout: "", stderr: "permission denied", exitCode: 1 }),
      now: () => {
        call++;
        return call === 1 ? new Date("2026-03-27T10:00:00Z") : new Date("2026-03-27T11:01:00Z");
      },
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-27T11:00:00Z", "--exec", "badcmd"], undefined, SESSION_CTX);

    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const historyKey = Object.keys(fs.store).find((k) => k.includes("/history/"))!;
    expect(historyKey).toBeTruthy();
    const record = JSON.parse(fs.store[historyKey]) as RunRecord;
    expect(record.status).toBe("error");
    expect(record.errorMessage).toContain("exited with code 1");
  });

  it("records error when allowExec is explicitly false", async () => {
    let call = 0;
    const deps = makeDeps({
      now: () => {
        call++;
        return call === 1 ? new Date("2026-03-27T10:00:00Z") : new Date("2026-03-27T11:01:00Z");
      },
    });

    // Create with default config (allowExec true), then tick with allowExec false
    // to simulate a config change mid-flight
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-27T11:00:00Z", "--exec", "badcmd"], undefined, SESSION_CTX);

    const tick = createTickFn({ ...BASE_CFG, allowExec: false }, deps, () => {});
    await tick();

    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const historyKey = Object.keys(fs.store).find((k) => k.includes("/history/"))!;
    expect(historyKey).toBeTruthy();
    const record = JSON.parse(fs.store[historyKey]) as RunRecord;
    expect(record.status).toBe("error");
    expect(record.errorMessage).toContain("exec actions are disabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// history
// ─────────────────────────────────────────────────────────────────────────────

describe("history", () => {
  it("shows no history initially", async () => {
    const deps = makeDeps();
    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "x"], undefined, SESSION_CTX);

    const r = await handler(["history", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("No run history");
  });

  it("shows history after a tick fires", async () => {
    let call = 0;
    const deps = makeDeps({
      promptFn: async () => "agent response",
      now: () => {
        call++;
        return call === 1 ? new Date("2026-03-27T10:00:00Z") : new Date("2026-03-27T11:01:00Z");
      },
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-27T11:00:00Z", "--prompt", "hey"], undefined, SESSION_CTX);

    const tick = createTickFn(BASE_CFG, deps, () => {});
    await tick();

    const r = await handler(["history", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("✓");
    expect(r.output).toContain("sched_test1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// test subcommand
// ─────────────────────────────────────────────────────────────────────────────

describe("test subcommand", () => {
  it("triggers the schedule immediately without advancing runCount on the saved entry", async () => {
    const prompted: string[] = [];
    const deps = makeDeps({
      promptFn: async (_, __, msg) => { prompted.push(msg); return "triggered!"; },
    });

    const handler = createHandler(BASE_CFG, deps);
    await handler(["create", "--once", "2026-03-28T09:00:00Z", "--prompt", "test me"], undefined, SESSION_CTX);

    const r = await handler(["test", "sched_test1"], undefined, SESSION_CTX);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("✓");
    expect(r.output).toContain("triggered!");

    // The saved schedule should NOT be mutated
    const fs = deps.fs as ReturnType<typeof makeFakeFs>;
    const key = Object.keys(fs.store).find((k) => k.includes("sched_test1.json"))!;
    const saved = JSON.parse(fs.store[key]) as ScheduleEntry;
    expect(saved.runCount).toBe(0);       // not incremented
    expect(saved.status).toBe("active");  // not completed

    // But history IS written
    const histKey = Object.keys(fs.store).find((k) => k.includes("/history/"))!;
    expect(histKey).toBeTruthy();
  });
});
