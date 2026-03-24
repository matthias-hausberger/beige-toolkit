/**
 * Schedule Tool Unit Tests
 */

import { describe, it, expect } from "bun:test";
import { createHandler, isValidCron, getNextRuns } from "../index.ts";

// Helper to create a mock store
function createMockStore() {
  const schedules = new Map<string, any>();

  return {
    getSchedules: (agentName: string) =>
      Array.from(schedules.values()).filter((s) => s.agentName === agentName),
    getAllSchedules: () => Array.from(schedules.values()),
    getSchedule: (id: string) => schedules.get(id),
    saveSchedule: (schedule: any) => schedules.set(schedule.id, schedule),
    deleteSchedule: (id: string) => schedules.delete(id),
    updateSchedule: (id: string, updates: any) => {
      const existing = schedules.get(id);
      if (!existing) return false;
      schedules.set(id, { ...existing, ...updates });
      return true;
    },
  };
}

describe("Cron Parser", () => {
  it("validates standard 5-field cron expressions", () => {
    expect(isValidCron("* * * * *").valid).toBe(true);
    expect(isValidCron("0 9 * * *").valid).toBe(true);
    expect(isValidCron("*/15 * * * *").valid).toBe(true);
    expect(isValidCron("0 14 * * 1-5").valid).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(isValidCron("* * * *").valid).toBe(false); // Too few fields
    expect(isValidCron("60 * * * *").valid).toBe(false); // Minute out of range
    expect(isValidCron("* 24 * * *").valid).toBe(false); // Hour out of range
    expect(isValidCron("abc * * * *").valid).toBe(false); // Invalid syntax
  });

  it("calculates next run times", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    const runs = getNextRuns("0 * * * *", 3, now);

    expect(runs.length).toBe(3);
    expect(runs[0].getHours()).toBe(11);
    expect(runs[1].getHours()).toBe(12);
    expect(runs[2].getHours()).toBe(13);
  });

  it("handles step expressions", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    const runs = getNextRuns("*/30 * * * *", 4, now);

    expect(runs.length).toBe(4);
    expect(runs[0].getMinutes()).toBe(30);
    expect(runs[1].getMinutes()).toBe(0);
    expect(runs[1].getHours()).toBe(11);
  });

  it("handles day of week constraints", () => {
    const now = new Date("2026-03-24T10:00:00Z"); // Tuesday
    const runs = getNextRuns("0 9 * * 0", 3, now); // Sundays at 9 AM

    expect(runs.length).toBe(3);
    // All runs should be on Sunday (day 0)
    for (const run of runs) {
      expect(run.getDay()).toBe(0);
    }
  });
});

describe("Schedule Tool Handler", () => {
  it("shows usage with no arguments", async () => {
    const store = createMockStore();
    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler([], {}, { agentName: "test-agent" });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("creates a schedule", async () => {
    const store = createMockStore();
    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["create", "0 9 * * *", "Good morning!"],
      {},
      { agentName: "test-agent", sessionKey: "test-session" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Schedule created");
    expect(result.output).toContain("0 9 * * *");

    const schedules = store.getSchedules("test-agent");
    expect(schedules.length).toBe(1);
    expect(schedules[0].message).toBe("Good morning!");
    expect(schedules[0].enabled).toBe(true);
  });

  it("rejects invalid cron expressions", async () => {
    const store = createMockStore();
    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["create", "invalid", "test message"],
      {},
      { agentName: "test-agent" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid cron expression");
  });

  it("lists schedules", async () => {
    const store = createMockStore();

    // Pre-populate with some schedules
    store.saveSchedule({
      id: "schedule-1",
      agentName: "test-agent",
      sessionKey: "test-session",
      cronExpression: "0 9 * * *",
      message: "Morning reminder",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });
    store.saveSchedule({
      id: "schedule-2",
      agentName: "test-agent",
      sessionKey: "test-session",
      cronExpression: "*/30 * * * *",
      message: "Half-hour check",
      enabled: false,
      createdAt: new Date().toISOString(),
      runCount: 5,
    });

    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["list"],
      {},
      { agentName: "test-agent" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("2 schedules");
    expect(result.output).toContain("Morning reminder");
    expect(result.output).toContain("Half-hour check");
  });

  it("shows empty list message when no schedules", async () => {
    const store = createMockStore();
    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["list"],
      {},
      { agentName: "test-agent" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No schedules found");
  });

  it("deletes a schedule", async () => {
    const store = createMockStore();
    store.saveSchedule({
      id: "schedule-to-delete",
      agentName: "test-agent",
      sessionKey: "test-session",
      cronExpression: "* * * * *",
      message: "Delete me",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });

    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["delete", "schedule-to-delete"],
      {},
      { agentName: "test-agent" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("deleted");

    const schedules = store.getSchedules("test-agent");
    expect(schedules.length).toBe(0);
  });

  it("enables and disables schedules", async () => {
    const store = createMockStore();
    store.saveSchedule({
      id: "toggle-test",
      agentName: "test-agent",
      sessionKey: "test-session",
      cronExpression: "* * * * *",
      message: "Toggle me",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });

    const handler = createHandler({}, { scheduleStore: store as any });

    // Disable
    const disableResult = await handler(
      ["disable", "toggle-test"],
      {},
      { agentName: "test-agent" }
    );
    expect(disableResult.exitCode).toBe(0);
    expect(disableResult.output).toContain("disabled");
    expect(store.getSchedule("toggle-test")?.enabled).toBe(false);

    // Enable
    const enableResult = await handler(
      ["enable", "toggle-test"],
      {},
      { agentName: "test-agent" }
    );
    expect(enableResult.exitCode).toBe(0);
    expect(enableResult.output).toContain("enabled");
    expect(store.getSchedule("toggle-test")?.enabled).toBe(true);
  });

  it("tests cron expressions", async () => {
    const store = createMockStore();
    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["test", "0 9 * * 1-5"],
      {},
      { agentName: "test-agent" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Cron expression: 0 9 * * 1-5");
    expect(result.output).toContain("Next 5 runs:");
  });

  it("isolates schedules by agent", async () => {
    const store = createMockStore();

    // Create schedule for agent-1
    store.saveSchedule({
      id: "agent1-schedule",
      agentName: "agent-1",
      sessionKey: "session-1",
      cronExpression: "* * * * *",
      message: "Agent 1 task",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });

    // Create schedule for agent-2
    store.saveSchedule({
      id: "agent2-schedule",
      agentName: "agent-2",
      sessionKey: "session-2",
      cronExpression: "* * * * *",
      message: "Agent 2 task",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });

    const handler = createHandler({}, { scheduleStore: store as any });

    // Agent-1 should only see their schedule
    const result1 = await handler(
      ["list"],
      {},
      { agentName: "agent-1" }
    );
    expect(result1.output).toContain("Agent 1 task");
    expect(result1.output).not.toContain("Agent 2 task");

    // Agent-2 should only see their schedule
    const result2 = await handler(
      ["list"],
      {},
      { agentName: "agent-2" }
    );
    expect(result2.output).toContain("Agent 2 task");
    expect(result2.output).not.toContain("Agent 1 task");

    // Agent-1 cannot delete Agent-2's schedule
    const deleteResult = await handler(
      ["delete", "agent2-schedule"],
      {},
      { agentName: "agent-1" }
    );
    expect(deleteResult.exitCode).toBe(1);
    expect(deleteResult.output).toContain("not found");
    expect(store.getSchedule("agent2-schedule")).toBeDefined();
  });

  it("rejects unknown subcommands", async () => {
    const store = createMockStore();
    const handler = createHandler({}, { scheduleStore: store as any });

    const result = await handler(
      ["unknown"],
      {},
      { agentName: "test-agent" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unknown subcommand");
  });
});
