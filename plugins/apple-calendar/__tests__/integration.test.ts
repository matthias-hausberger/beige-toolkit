/**
 * Integration tests for the calendar tool.
 *
 * Covers manifest validity and end-to-end permission + executor flows.
 * No real calendar-cli process is spawned — an executor stub is injected.
 */

import { describe, it, expect } from "vitest";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import {
  assertValidToolManifest,
  assertSuccess,
  assertFailure,
} from "../../../test-utils/assertions.js";
import { createHandler, type Executor } from "../index.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("tool manifest", () => {
  const manifest = loadToolManifest("plugins/apple-calendar");

  it("is valid", () => {
    assertValidToolManifest(manifest);
  });

  it("has name apple-calendar", () => {
    expect(manifest.name).toBe("apple-calendar");
  });


  it("lists at least one command example", () => {
    expect(manifest.commands?.length).toBeGreaterThan(0);
  });

  it("commands cover calendars and events", () => {
    const cmds = manifest.commands?.join(" ") ?? "";
    expect(cmds).toContain("calendars");
    expect(cmds).toContain("events");
  });

  it("commands cover today, date, range, and search", () => {
    const cmds = manifest.commands?.join(" ") ?? "";
    expect(cmds).toContain("today");
    expect(cmds).toContain("date");
    expect(cmds).toContain("range");
    expect(cmds).toContain("search");
  });
});

// ---------------------------------------------------------------------------
// Stub executor
// ---------------------------------------------------------------------------

function makeExecutor(
  response: string = "[]",
  exitCode = 0
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: response, stderr: "", exitCode };
    },
    { calls }
  );
}

// ---------------------------------------------------------------------------
// Sample JSON responses for realistic E2E tests
// ---------------------------------------------------------------------------

const SAMPLE_CALENDARS = JSON.stringify([
  {
    title: "Main Calendar",
    source: "iCloud",
    type: "caldav",
    color: "#1badf8",
    immutable: false,
  },
  {
    title: "Work",
    source: "Google",
    type: "caldav",
    color: "#7ae7bf",
    immutable: false,
  },
  {
    title: "Birthdays",
    source: "Other",
    type: "birthday",
    color: "#8295af",
    immutable: true,
  },
]);

const SAMPLE_EVENTS_TODAY = JSON.stringify([
  {
    title: "Standup",
    start: "2026-03-19T09:15:00",
    end: "2026-03-19T09:30:00",
    allDay: false,
    calendar: "Work",
    calendarSource: "Google",
    attendees: [
      { name: "alice@example.com", email: "alice@example.com", status: "accepted" },
      { name: "bob@example.com", email: "bob@example.com", status: "tentative" },
    ],
  },
  {
    title: "Lunch",
    start: "2026-03-19T12:00:00",
    end: "2026-03-19T13:00:00",
    allDay: false,
    calendar: "Work",
    calendarSource: "Google",
  },
]);

const SAMPLE_SEARCH = JSON.stringify([
  {
    title: "EXO/P13N Standup",
    start: "2026-03-17T09:15:00",
    end: "2026-03-17T09:30:00",
    allDay: false,
    calendar: "Work",
    calendarSource: "Google",
  },
  {
    title: "EXO/P13N Standup",
    start: "2026-03-19T09:15:00",
    end: "2026-03-19T09:30:00",
    allDay: false,
    calendar: "Work",
    calendarSource: "Google",
  },
]);

// ---------------------------------------------------------------------------
// Full E2E flows — list calendars
// ---------------------------------------------------------------------------

describe("E2E — list calendars", () => {
  it("returns calendar list on success", async () => {
    const exec = makeExecutor(SAMPLE_CALENDARS);
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["calendars"]);

    assertSuccess(result);
    expect(result.output).toContain("Main Calendar");
    expect(result.output).toContain("Work");
    expect(result.output).toContain("Birthdays");
  });
});

// ---------------------------------------------------------------------------
// Full E2E flows — events today
// ---------------------------------------------------------------------------

describe("E2E — events today", () => {
  it("returns today's events", async () => {
    const exec = makeExecutor(SAMPLE_EVENTS_TODAY);
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "today"]);

    assertSuccess(result);
    expect(result.output).toContain("Standup");
    expect(result.output).toContain("Lunch");
    expect(result.output).toContain("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// Full E2E flows — events for a specific date
// ---------------------------------------------------------------------------

describe("E2E — events date", () => {
  it("passes date through to executor", async () => {
    const exec = makeExecutor("[]");
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "date", "2026-03-20"]);

    assertSuccess(result);
    expect(exec.calls[0].args).toEqual(["events", "date", "2026-03-20"]);
  });
});

// ---------------------------------------------------------------------------
// Full E2E flows — events range
// ---------------------------------------------------------------------------

describe("E2E — events range", () => {
  it("passes range through to executor", async () => {
    const exec = makeExecutor("[]");
    const handler = createHandler({}, { executor: exec });
    const result = await handler([
      "events",
      "range",
      "2026-03-18",
      "2026-03-21",
    ]);

    assertSuccess(result);
    expect(exec.calls[0].args).toEqual([
      "events",
      "range",
      "2026-03-18",
      "2026-03-21",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Full E2E flows — events search
// ---------------------------------------------------------------------------

describe("E2E — events search", () => {
  it("returns matching events", async () => {
    const exec = makeExecutor(SAMPLE_SEARCH);
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "search", "standup"]);

    assertSuccess(result);
    expect(result.output).toContain("EXO/P13N Standup");
  });

  it("passes --from and --to flags through", async () => {
    const exec = makeExecutor("[]");
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
});

// ---------------------------------------------------------------------------
// Error passthrough
// ---------------------------------------------------------------------------

describe("error passthrough", () => {
  it("surfaces calendar-cli errors clearly", async () => {
    const exec = makeExecutor(
      '{"error":"Invalid date format: \'bad-date\'. Expected yyyy-MM-dd."}',
      1
    );
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "date", "bad-date"]);

    assertFailure(result);
    expect(result.output).toContain("Invalid date format");
  });
});

// ---------------------------------------------------------------------------
// Read-only agent (events only, no calendars)
// ---------------------------------------------------------------------------

describe("events-only agent config", () => {
  const config = {
    allowedCommands: ["events today", "events date", "events range"],
  };

  it("can get today's events", async () => {
    const exec = makeExecutor(SAMPLE_EVENTS_TODAY);
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["events", "today"]);
    assertSuccess(result);
    expect(result.output).toContain("Standup");
  });

  it("can get events for a date", async () => {
    const exec = makeExecutor("[]");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["events", "date", "2026-03-20"]);
    assertSuccess(result);
  });

  it("cannot list calendars", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["calendars"]);
    assertFailure(result);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot search events", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["events", "search", "standup"]);
    assertFailure(result);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deny beats allow
// ---------------------------------------------------------------------------

describe("deny beats allow", () => {
  it("deniedCommands overrides allowedCommands for the same path", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      {
        allowedCommands: ["events today", "events search"],
        deniedCommands: ["events search"],
      },
      { executor: exec }
    );

    const denied = await handler(["events", "search", "standup"]);
    assertFailure(denied);
    expect(denied.output).toContain("Permission denied");

    const allowed = await handler(["events", "today"]);
    assertSuccess(allowed);
  });
});

// ---------------------------------------------------------------------------
// Exit code passthrough
// ---------------------------------------------------------------------------

describe("exit code passthrough", () => {
  it("passes non-zero exit code through unchanged", async () => {
    const exec = makeExecutor('{"error":"something went wrong"}', 1);
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["events", "today"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("something went wrong");
  });
});
