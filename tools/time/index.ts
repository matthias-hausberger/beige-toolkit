#!/usr/bin/env bun
/**
 * Time Tool - Time and date manipulation
 *
 * Provides commands for:
 * - now: Get current time
 * - format: Format dates
 * - parse: Parse date strings
 * - add: Add time to a date
 * - subtract: Subtract time from a date
 * - diff: Calculate difference between dates
 * - start: Get start of period (day, week, month, etc.)
 * - end: Get end of period
 * - is: Check date properties (before, after, between, etc.)
 * - convert: Convert between timezones
 */

interface TimeConfig {
  defaultTimezone?: string;
  defaultFormat?: string;
  allowedTimezones?: string[];
}

// Time units in milliseconds
const UNITS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  M: 30 * 24 * 60 * 60 * 1000, // Approximate
  month: 30 * 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000, // Approximate
  year: 365 * 24 * 60 * 60 * 1000,
  years: 365 * 24 * 60 * 60 * 1000,
};

function parseArgs(args: string[]): {
  command: string;
  options: Record<string, string | boolean>;
  positional: string[];
} {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options[key] = args[++i];
      } else {
        options[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options[key] = args[++i];
      } else {
        options[key] = true;
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, options, positional };
}

function parseDate(input: string, timezone?: string): Date {
  // Handle relative times
  if (input === "now") {
    return new Date();
  }

  // Handle "in X units" format
  const inMatch = input.match(/^in\s+(\d+)\s+(\w+)$/i);
  if (inMatch) {
    const amount = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const ms = UNITS[unit];
    if (ms) {
      return new Date(Date.now() + amount * ms);
    }
  }

  // Handle "X units ago" format
  const agoMatch = input.match(/^(\d+)\s+(\w+)\s+ago$/i);
  if (agoMatch) {
    const amount = parseInt(agoMatch[1]);
    const unit = agoMatch[2].toLowerCase();
    const ms = UNITS[unit];
    if (ms) {
      return new Date(Date.now() - amount * ms);
    }
  }

  // Handle ISO and other standard formats
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  // Handle Unix timestamp
  const timestamp = parseInt(input);
  if (!isNaN(timestamp)) {
    // Assume seconds if < 1e12, milliseconds otherwise
    return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  }

  throw new Error(`Cannot parse date: ${input}`);
}

function formatDate(date: Date, format: string, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {};

  // Set timezone
  if (timezone) {
    opts.timeZone = timezone;
  }

  // Handle named formats
  switch (format.toLowerCase()) {
    case "iso":
      return date.toISOString();

    case "iso-date":
      return date.toISOString().split("T")[0];

    case "iso-time":
      return date.toISOString().split("T")[1].split(".")[0];

    case "unix":
    case "timestamp":
      return Math.floor(date.getTime() / 1000).toString();

    case "unix-ms":
    case "timestamp-ms":
      return date.getTime().toString();

    case "rfc2822":
      return date.toUTCString();

    case "rfc3339":
      return date.toISOString().replace(".000Z", "Z");

    case "date":
      opts.dateStyle = "medium";
      return new Intl.DateTimeFormat("en-US", opts).format(date);

    case "time":
      opts.timeStyle = "medium";
      return new Intl.DateTimeFormat("en-US", opts).format(date);

    case "datetime":
      opts.dateStyle = "medium";
      opts.timeStyle = "medium";
      return new Intl.DateTimeFormat("en-US", opts).format(date);

    case "long":
      opts.dateStyle = "long";
      opts.timeStyle = "long";
      return new Intl.DateTimeFormat("en-US", opts).format(date);

    case "short":
      opts.dateStyle = "short";
      opts.timeStyle = "short";
      return new Intl.DateTimeFormat("en-US", opts).format(date);

    default:
      // Handle custom format string
      return formatCustom(date, format, timezone);
  }
}

function formatCustom(date: Date, format: string, timezone?: string): string {
  // Simple custom format replacement
  // YYYY = 4-digit year, YY = 2-digit year
  // MM = 2-digit month, M = month
  // DD = 2-digit day, D = day
  // HH = 2-digit hour (24), H = hour
  // hh = 2-digit hour (12), h = hour
  // mm = 2-digit minute, m = minute
  // ss = 2-digit second, s = second
  // A = AM/PM, a = am/pm

  const d = date;
  let result = format;

  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour24 = d.getHours();
  const hour12 = hour24 % 12 || 12;
  const minute = d.getMinutes();
  const second = d.getSeconds();
  const ampm = hour24 < 12 ? "AM" : "am";

  result = result.replace(/YYYY/g, year.toString());
  result = result.replace(/YY/g, year.toString().slice(-2));
  result = result.replace(/MM/g, month.toString().padStart(2, "0"));
  result = result.replace(/M/g, month.toString());
  result = result.replace(/DD/g, day.toString().padStart(2, "0"));
  result = result.replace(/D/g, day.toString());
  result = result.replace(/HH/g, hour24.toString().padStart(2, "0"));
  result = result.replace(/H/g, hour24.toString());
  result = result.replace(/hh/g, hour12.toString().padStart(2, "0"));
  result = result.replace(/h/g, hour12.toString());
  result = result.replace(/mm/g, minute.toString().padStart(2, "0"));
  result = result.replace(/m/g, minute.toString());
  result = result.replace(/ss/g, second.toString().padStart(2, "0"));
  result = result.replace(/s/g, second.toString());
  result = result.replace(/A/g, ampm.toUpperCase());
  result = result.replace(/a/g, ampm.toLowerCase());

  return result;
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(\w+)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const ms = UNITS[unit];

  if (!ms) {
    throw new Error(`Unknown time unit: ${unit}`);
  }

  return amount * ms;
}

function cmdNow(options: Record<string, string | boolean>, config: TimeConfig): string {
  const format = String(options.format || options.f || config.defaultFormat || "iso");
  const timezone = String(options.timezone || options.t || config.defaultTimezone || "UTC");
  return formatDate(new Date(), format, timezone);
}

function cmdFormat(
  dateStr: string,
  options: Record<string, string | boolean>,
  config: TimeConfig
): string {
  const format = String(options.format || options.f || config.defaultFormat || "iso");
  const timezone = String(options.timezone || options.t || config.defaultTimezone || "UTC");
  const date = parseDate(dateStr, timezone);
  return formatDate(date, format, timezone);
}

function cmdParse(dateStr: string): string {
  const date = parseDate(dateStr);
  return JSON.stringify({
    input: dateStr,
    iso: date.toISOString(),
    unix: Math.floor(date.getTime() / 1000),
    unixMs: date.getTime(),
    local: date.toString(),
    utc: date.toUTCString(),
  }, null, 2);
}

function cmdAdd(
  dateStr: string,
  duration: string,
  options: Record<string, string | boolean>,
  config: TimeConfig
): string {
  const date = parseDate(dateStr);
  const ms = parseDuration(duration);
  const result = new Date(date.getTime() + ms);
  const format = String(options.format || options.f || "iso");
  return formatDate(result, format, config.defaultTimezone);
}

function cmdSubtract(
  dateStr: string,
  duration: string,
  options: Record<string, string | boolean>,
  config: TimeConfig
): string {
  const date = parseDate(dateStr);
  const ms = parseDuration(duration);
  const result = new Date(date.getTime() - ms);
  const format = String(options.format || options.f || "iso");
  return formatDate(result, format, config.defaultTimezone);
}

function cmdDiff(date1Str: string, date2Str: string): string {
  const date1 = parseDate(date1Str);
  const date2 = parseDate(date2Str);
  const diffMs = Math.abs(date2.getTime() - date1.getTime());

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  return JSON.stringify({
    from: date1.toISOString(),
    to: date2.toISOString(),
    milliseconds: diffMs,
    seconds,
    minutes,
    hours,
    days,
    weeks,
    months,
    years,
    human: formatHumanDuration(diffMs),
  }, null, 2);
}

function formatHumanDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""}`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours} hour${hours !== 1 ? "s" : ""}`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days < 7) {
    return remainingHours > 0
      ? `${days}d ${remainingHours}h`
      : `${days} day${days !== 1 ? "s" : ""}`;
  }

  const weeks = Math.floor(days / 7);
  const remainingDays = days % 7;
  return remainingDays > 0
    ? `${weeks}w ${remainingDays}d`
    : `${weeks} week${weeks !== 1 ? "s" : ""}`;
}

function cmdStart(
  dateStr: string,
  period: string,
  options: Record<string, string | boolean>,
  config: TimeConfig
): string {
  const date = parseDate(dateStr);
  let result: Date;

  switch (period.toLowerCase()) {
    case "second":
      result = new Date(date.getTime());
      result.setUTCMilliseconds(0);
      break;

    case "minute":
      result = new Date(date.getTime());
      result.setUTCSeconds(0, 0);
      break;

    case "hour":
      result = new Date(date.getTime());
      result.setUTCMinutes(0, 0, 0);
      break;

    case "day":
      result = new Date(date.getTime());
      result.setUTCHours(0, 0, 0, 0);
      break;

    case "week":
      result = new Date(date.getTime());
      result.setUTCHours(0, 0, 0, 0);
      result.setUTCDate(result.getUTCDate() - result.getUTCDay());
      break;

    case "month":
      result = new Date(date.getTime());
      result.setUTCHours(0, 0, 0, 0);
      result.setUTCDate(1);
      break;

    case "year":
      result = new Date(date.getTime());
      result.setUTCHours(0, 0, 0, 0);
      result.setUTCMonth(0, 1);
      break;

    default:
      throw new Error(`Unknown period: ${period}. Use: second, minute, hour, day, week, month, year`);
  }

  const format = String(options.format || options.f || "iso");
  return formatDate(result, format, config.defaultTimezone);
}

function cmdEnd(
  dateStr: string,
  period: string,
  options: Record<string, string | boolean>,
  config: TimeConfig
): string {
  const date = parseDate(dateStr);
  let result: Date;

  switch (period.toLowerCase()) {
    case "second":
      result = new Date(date.getTime());
      result.setUTCMilliseconds(999);
      break;

    case "minute":
      result = new Date(date.getTime());
      result.setUTCSeconds(59, 999);
      break;

    case "hour":
      result = new Date(date.getTime());
      result.setUTCMinutes(59, 59, 999);
      break;

    case "day":
      result = new Date(date.getTime());
      result.setUTCHours(23, 59, 59, 999);
      break;

    case "week":
      result = new Date(date.getTime());
      result.setUTCHours(23, 59, 59, 999);
      result.setUTCDate(result.getUTCDate() + (6 - result.getUTCDay()));
      break;

    case "month":
      result = new Date(date.getTime());
      result.setUTCHours(23, 59, 59, 999);
      result.setUTCMonth(result.getUTCMonth() + 1, 0); // Last day of month
      break;

    case "year":
      result = new Date(date.getTime());
      result.setUTCHours(23, 59, 59, 999);
      result.setUTCMonth(11, 31); // Dec 31
      break;

    default:
      throw new Error(`Unknown period: ${period}. Use: second, minute, hour, day, week, month, year`);
  }

  const format = String(options.format || options.f || "iso");
  return formatDate(result, format, config.defaultTimezone);
}

function cmdIs(date1Str: string, operation: string, date2Str: string, date3Str?: string): string {
  const date1 = parseDate(date1Str);
  const date2 = parseDate(date2Str);

  let result: boolean;

  switch (operation.toLowerCase()) {
    case "before":
    case "<":
      result = date1.getTime() < date2.getTime();
      break;

    case "after":
    case ">":
      result = date1.getTime() > date2.getTime();
      break;

    case "same":
    case "eq":
    case "==":
      result = date1.getTime() === date2.getTime();
      break;

    case "before-or-same":
    case "<=":
      result = date1.getTime() <= date2.getTime();
      break;

    case "after-or-same":
    case ">=":
      result = date1.getTime() >= date2.getTime();
      break;

    case "between": {
      if (!date3Str) {
        throw new Error("between operation requires a third date argument");
      }
      const date3 = parseDate(date3Str);
      const min = Math.min(date2.getTime(), date3.getTime());
      const max = Math.max(date2.getTime(), date3.getTime());
      result = date1.getTime() >= min && date1.getTime() <= max;
      break;
    }

    default:
      throw new Error(`Unknown operation: ${operation}. Use: before, after, same, before-or-same, after-or-same, between`);
  }

  return JSON.stringify({
    date1: date1.toISOString(),
    operation,
    date2: date2.toISOString(),
    result,
  }, null, 2);
}

function cmdConvert(
  dateStr: string,
  timezone: string,
  options: Record<string, string | boolean>,
  config: TimeConfig
): string {
  const date = parseDate(dateStr);
  const format = String(options.format || options.f || "datetime");
  return formatDate(date, format, timezone);
}

function showHelp(): string {
  return `
Time Tool - Time and date manipulation

USAGE:
  time <command> [options] [arguments]

COMMANDS:
  now                         Get current time
    --format, -f <format>     Output format
    --timezone, -t <tz>       Timezone (default: UTC)

  format <date>               Format a date
    --format, -f <format>     Output format
    --timezone, -t <tz>       Timezone

  parse <date>                Parse a date string to all formats

  add <date> <duration>       Add duration to date
    --format, -f <format>     Output format

  subtract <date> <duration>  Subtract duration from date
    --format, -f <format>     Output format

  diff <date1> <date2>        Calculate difference between dates

  start <date> <period>       Get start of period
    Periods: second, minute, hour, day, week, month, year

  end <date> <period>         Get end of period

  is <date1> <op> <date2>     Compare dates
    Operations: before, after, same, before-or-same, after-or-same, between

  convert <date> <timezone>   Convert to timezone
    --format, -f <format>     Output format

FORMATS:
  iso         ISO 8601 format (default)
  iso-date    ISO date only (YYYY-MM-DD)
  iso-time    ISO time only (HH:mm:ss)
  unix        Unix timestamp (seconds)
  unix-ms     Unix timestamp (milliseconds)
  rfc2822     RFC 2822 format
  rfc3339     RFC 3339 format
  date        Human-readable date
  time        Human-readable time
  datetime    Human-readable date and time
  long        Long format
  short       Short format
  custom      Custom format (e.g., YYYY-MM-DD HH:mm:ss)

DURATIONS:
  Use format: <number><unit>
  Units: ms, s, m, h, d, w, M, y
  Examples: 5s, 10m, 2h, 3d, 1w, 6M, 1y

RELATIVE DATES:
  now                 Current time
  in <n> <unit>       Future time (e.g., "in 5 days")
  <n> <unit> ago      Past time (e.g., "2 hours ago")

EXAMPLES:
  time now
  time now -f unix
  time now -t "America/New_York" -f datetime
  time format "2024-01-15" -f "YYYY-MM-DD"
  time parse "2024-01-15T10:30:00Z"
  time add now 5d
  time subtract now 2h
  time diff "2024-01-01" "2024-12-31"
  time start now week
  time end now month
  time is "2024-01-01" before "2024-12-31"
  time convert now "Europe/London"
`;
}

async function main(args: string[], config: TimeConfig = {}): Promise<string> {
  const { command, options, positional } = parseArgs(args);

  switch (command) {
    case "":
    case "help":
    case "--help":
    case "-h":
      return showHelp();

    case "now":
      return cmdNow(options, config);

    case "format":
      if (positional.length < 1) {
        throw new Error("format requires a date argument");
      }
      return cmdFormat(positional[0], options, config);

    case "parse":
      if (positional.length < 1) {
        throw new Error("parse requires a date argument");
      }
      return cmdParse(positional[0]);

    case "add":
      if (positional.length < 2) {
        throw new Error("add requires date and duration arguments");
      }
      return cmdAdd(positional[0], positional[1], options, config);

    case "subtract":
    case "sub":
      if (positional.length < 2) {
        throw new Error("subtract requires date and duration arguments");
      }
      return cmdSubtract(positional[0], positional[1], options, config);

    case "diff":
    case "difference":
      if (positional.length < 2) {
        throw new Error("diff requires two date arguments");
      }
      return cmdDiff(positional[0], positional[1]);

    case "start":
    case "begin":
      if (positional.length < 2) {
        throw new Error("start requires date and period arguments");
      }
      return cmdStart(positional[0], positional[1], options, config);

    case "end":
      if (positional.length < 2) {
        throw new Error("end requires date and period arguments");
      }
      return cmdEnd(positional[0], positional[1], options, config);

    case "is":
    case "compare":
      if (positional.length < 3) {
        throw new Error("is requires date1, operation, and date2 arguments");
      }
      return cmdIs(positional[0], positional[1], positional[2], positional[3]);

    case "convert":
    case "tz":
    case "timezone":
      if (positional.length < 2) {
        throw new Error("convert requires date and timezone arguments");
      }
      return cmdConvert(positional[0], positional[1], options, config);

    default:
      throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

// Run if called directly
if (import.meta.main) {
  const args = Deno.args;
  const config: TimeConfig = {
    defaultTimezone: Deno.env.get("TIME_DEFAULT_TIMEZONE") || "UTC",
    defaultFormat: Deno.env.get("TIME_DEFAULT_FORMAT") || "iso",
  };

  main(args, config)
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      Deno.exit(1);
    });
}

export { main as timeTool, parseDate, formatDate, parseDuration };
