import { assertEquals, assertMatch } from "jsr:@std/assert";
import { timeTool, parseDate, formatDate, parseDuration } from "../index.ts";

const config = { defaultTimezone: "UTC", defaultFormat: "iso" };

// Helper for async rejection testing
async function expectReject(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected promise to reject, but it resolved");
  } catch {
    // Expected
  }
}

// ============ HELP TESTS ============
Deno.test("help - shows help with no args", async () => {
  const result = await timeTool([], config);
  assertMatch(result, /Time Tool/);
  assertMatch(result, /COMMANDS/);
});

Deno.test("help - shows help with --help", async () => {
  const result = await timeTool(["--help"], config);
  assertMatch(result, /Time Tool/);
});

// ============ PARSE DATE TESTS ============
Deno.test("parseDate - parses ISO date", () => {
  const result = parseDate("2024-01-15T10:30:00Z");
  assertEquals(result.toISOString(), "2024-01-15T10:30:00.000Z");
});

Deno.test("parseDate - parses now", () => {
  const result = parseDate("now");
  const now = new Date();
  assertEquals(Math.abs(result.getTime() - now.getTime()) < 1000, true);
});

Deno.test("parseDate - parses Unix timestamp (seconds)", () => {
  const result = parseDate("1705315800");
  assertEquals(result.toISOString(), "2024-01-15T10:50:00.000Z");
});

Deno.test("parseDate - parses Unix timestamp (milliseconds)", () => {
  const result = parseDate("1705315800000");
  assertEquals(result.toISOString(), "2024-01-15T10:50:00.000Z");
});

Deno.test("parseDate - parses relative 'in X units'", () => {
  const result = parseDate("in 5 seconds");
  const expected = new Date(Date.now() + 5000);
  assertEquals(Math.abs(result.getTime() - expected.getTime()) < 100, true);
});

Deno.test("parseDate - parses relative 'X units ago'", () => {
  const result = parseDate("2 hours ago");
  const expected = new Date(Date.now() - 2 * 60 * 60 * 1000);
  assertEquals(Math.abs(result.getTime() - expected.getTime()) < 100, true);
});

// ============ FORMAT DATE TESTS ============
Deno.test("formatDate - ISO format", () => {
  const date = new Date("2024-01-15T10:30:00Z");
  const result = formatDate(date, "iso");
  assertEquals(result, "2024-01-15T10:30:00.000Z");
});

Deno.test("formatDate - ISO date format", () => {
  const date = new Date("2024-01-15T10:30:00Z");
  const result = formatDate(date, "iso-date");
  assertEquals(result, "2024-01-15");
});

Deno.test("formatDate - Unix timestamp format", () => {
  const date = new Date("2024-01-15T10:30:00Z");
  const result = formatDate(date, "unix");
  assertEquals(result, "1705314600");
});

Deno.test("formatDate - Unix milliseconds format", () => {
  const date = new Date("2024-01-15T10:30:00Z");
  const result = formatDate(date, "unix-ms");
  assertEquals(result, "1705314600000");
});

Deno.test("formatDate - custom format YYYY-MM-DD", () => {
  const date = new Date("2024-01-15T10:30:00Z");
  const result = formatDate(date, "YYYY-MM-DD");
  assertEquals(result, "2024-01-15");
});

Deno.test("formatDate - custom format with time", () => {
  const date = new Date("2024-01-15T10:30:45Z");
  const result = formatDate(date, "HH:mm:ss");
  assertEquals(result, "10:30:45");
});

// ============ PARSE DURATION TESTS ============
Deno.test("parseDuration - parses seconds", () => {
  assertEquals(parseDuration("5s"), 5000);
  assertEquals(parseDuration("30 seconds"), 30000);
});

Deno.test("parseDuration - parses minutes", () => {
  assertEquals(parseDuration("10m"), 600000);
  assertEquals(parseDuration("5 minutes"), 300000);
});

Deno.test("parseDuration - parses hours", () => {
  assertEquals(parseDuration("2h"), 7200000);
  assertEquals(parseDuration("1 hour"), 3600000);
});

Deno.test("parseDuration - parses days", () => {
  assertEquals(parseDuration("1d"), 86400000);
  assertEquals(parseDuration("7 days"), 604800000);
});

Deno.test("parseDuration - parses weeks", () => {
  assertEquals(parseDuration("1w"), 604800000);
});

Deno.test("parseDuration - throws on invalid format", () => {
  try {
    parseDuration("invalid");
    assertEquals(true, false); // Should not reach here
  } catch (e) {
    assertMatch((e as Error).message, /Invalid duration/);
  }
});

// ============ NOW COMMAND TESTS ============
Deno.test("now - returns current time in ISO format", async () => {
  const result = await timeTool(["now"], config);
  assertMatch(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

Deno.test("now - returns Unix timestamp", async () => {
  const result = await timeTool(["now", "-f", "unix"], config);
  assertEquals(/^\d+$/.test(result), true);
});

// ============ FORMAT COMMAND TESTS ============
Deno.test("format - formats date", async () => {
  const result = await timeTool(["format", "2024-01-15T10:30:00Z"], config);
  assertEquals(result, "2024-01-15T10:30:00.000Z");
});

Deno.test("format - with custom format", async () => {
  const result = await timeTool(
    ["format", "2024-01-15T10:30:00Z", "-f", "YYYY-MM-DD"],
    config
  );
  assertEquals(result, "2024-01-15");
});

// ============ PARSE COMMAND TESTS ============
Deno.test("parse - returns JSON with all formats", async () => {
  const result = await timeTool(["parse", "2024-01-15T10:30:00Z"], config);
  const parsed = JSON.parse(result);
  assertEquals(parsed.iso, "2024-01-15T10:30:00.000Z");
  assertEquals(parsed.unix, 1705314600);
  assertEquals(parsed.unixMs, 1705314600000);
});

// ============ ADD COMMAND TESTS ============
Deno.test("add - adds duration to date", async () => {
  const result = await timeTool(["add", "2024-01-15T10:30:00Z", "1d"], config);
  assertEquals(result, "2024-01-16T10:30:00.000Z");
});

Deno.test("add - adds hours", async () => {
  const result = await timeTool(["add", "2024-01-15T10:30:00Z", "2h"], config);
  assertEquals(result, "2024-01-15T12:30:00.000Z");
});

// ============ SUBTRACT COMMAND TESTS ============
Deno.test("subtract - subtracts duration from date", async () => {
  const result = await timeTool(
    ["subtract", "2024-01-15T10:30:00Z", "1d"],
    config
  );
  assertEquals(result, "2024-01-14T10:30:00.000Z");
});

Deno.test("subtract - subtracts hours", async () => {
  const result = await timeTool(
    ["subtract", "2024-01-15T10:30:00Z", "5h"],
    config
  );
  assertEquals(result, "2024-01-15T05:30:00.000Z");
});

// ============ DIFF COMMAND TESTS ============
Deno.test("diff - calculates difference", async () => {
  const result = await timeTool(
    ["diff", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"],
    config
  );
  const parsed = JSON.parse(result);
  assertEquals(parsed.days, 1);
  assertEquals(parsed.hours, 24);
});

Deno.test("diff - handles reverse order", async () => {
  const result = await timeTool(
    ["diff", "2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z"],
    config
  );
  const parsed = JSON.parse(result);
  assertEquals(parsed.days, 1); // Always positive
});

// ============ START COMMAND TESTS ============
Deno.test("start - start of day", async () => {
  const result = await timeTool(
    ["start", "2024-01-15T10:30:00Z", "day"],
    config
  );
  assertEquals(result, "2024-01-15T00:00:00.000Z");
});

Deno.test("start - start of week", async () => {
  const result = await timeTool(
    ["start", "2024-01-17T10:30:00Z", "week"], // Wednesday
    config
  );
  assertEquals(result, "2024-01-14T00:00:00.000Z"); // Sunday
});

Deno.test("start - start of month", async () => {
  const result = await timeTool(
    ["start", "2024-01-15T10:30:00Z", "month"],
    config
  );
  assertEquals(result, "2024-01-01T00:00:00.000Z");
});

Deno.test("start - start of year", async () => {
  const result = await timeTool(
    ["start", "2024-06-15T10:30:00Z", "year"],
    config
  );
  assertEquals(result, "2024-01-01T00:00:00.000Z");
});

// ============ END COMMAND TESTS ============
Deno.test("end - end of day", async () => {
  const result = await timeTool(
    ["end", "2024-01-15T10:30:00Z", "day"],
    config
  );
  assertEquals(result, "2024-01-15T23:59:59.999Z");
});

Deno.test("end - end of month", async () => {
  const result = await timeTool(
    ["end", "2024-01-15T10:30:00Z", "month"],
    config
  );
  assertEquals(result, "2024-01-31T23:59:59.999Z");
});

Deno.test("end - end of year", async () => {
  const result = await timeTool(
    ["end", "2024-06-15T10:30:00Z", "year"],
    config
  );
  assertEquals(result, "2024-12-31T23:59:59.999Z");
});

// ============ IS COMMAND TESTS ============
Deno.test("is - before", async () => {
  const result = await timeTool(
    ["is", "2024-01-01", "before", "2024-12-31"],
    config
  );
  const parsed = JSON.parse(result);
  assertEquals(parsed.result, true);
});

Deno.test("is - after", async () => {
  const result = await timeTool(
    ["is", "2024-12-31", "after", "2024-01-01"],
    config
  );
  const parsed = JSON.parse(result);
  assertEquals(parsed.result, true);
});

Deno.test("is - same", async () => {
  const result = await timeTool(
    ["is", "2024-01-15T10:30:00Z", "same", "2024-01-15T10:30:00Z"],
    config
  );
  const parsed = JSON.parse(result);
  assertEquals(parsed.result, true);
});

Deno.test("is - between", async () => {
  const result = await timeTool(
    ["is", "2024-06-15", "between", "2024-01-01", "2024-12-31"],
    config
  );
  const parsed = JSON.parse(result);
  assertEquals(parsed.result, true);
});

// ============ CONVERT COMMAND TESTS ============
Deno.test("convert - to different timezone", async () => {
  const result = await timeTool(
    ["convert", "2024-01-15T12:00:00Z", "UTC", "-f", "datetime"],
    config
  );
  assertMatch(result, /Jan.*15.*2024/);
});

// ============ ERROR HANDLING TESTS ============
Deno.test("format - requires date argument", () => {
  return expectReject(timeTool(["format"], config));
});

Deno.test("add - requires date and duration", () => {
  return expectReject(timeTool(["add", "now"], config));
});

Deno.test("diff - requires two dates", () => {
  return expectReject(timeTool(["diff", "now"], config));
});

Deno.test("is - requires three arguments", () => {
  return expectReject(timeTool(["is", "now", "before"], config));
});
