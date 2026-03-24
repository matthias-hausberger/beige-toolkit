#!/usr/bin/env bun
/**
 * SQLite Database Tool
 *
 * Query SQLite databases with SQL. Supports SELECT queries, schema inspection,
 * and (optionally) write operations.
 *
 * @example
 *   /tools/bin/sqlite query --db /path/to/data.db "SELECT * FROM users LIMIT 10"
 *   /tools/bin/sqlite tables --db /path/to/data.db
 *   /tools/bin/sqlite schema --db /path/to/data.db --table users
 */

import { parseArgs } from "node:util";
import { $ } from "bun";
import { glob } from "glob";
import path from "node:path";

// Configuration (set via environment or tool config)
const CONFIG = {
  allowDatabases: (process.env.SQLITE_ALLOW_DATABASES || "")
    .split(",")
    .filter(Boolean),
  denyDatabases: (process.env.SQLITE_DENY_DATABASES || "")
    .split(",")
    .filter(Boolean),
  defaultDatabase: process.env.SQLITE_DEFAULT_DATABASE || "",
  maxRows: parseInt(process.env.SQLITE_MAX_ROWS || "1000", 10),
  readonly: process.env.SQLITE_READONLY !== "false",
};

// Help text
const HELP = `
SQLite Database Tool - Query SQLite databases with SQL

USAGE:
  sqlite <command> [options]

COMMANDS:
  query <sql>              Execute a SQL query
  tables                   List all tables in the database
  schema [--table <name>]  Show schema for table(s)
  databases                List allowed databases (from config)
  validate <sql>           Validate SQL syntax without executing

OPTIONS:
  --db <path>              Database path (required unless default set)
  --table <name>           Table name for schema command
  --format <fmt>           Output format: json, table, csv (default: json)
  --limit <n>              Override max rows for this query
  --help, -h               Show this help message

EXAMPLES:
  sqlite query --db /data/app.db "SELECT * FROM users LIMIT 10"
  sqlite tables --db /data/app.db
  sqlite schema --db /data/app.db --table users
  sqlite query --db /data/app.db "SELECT COUNT(*) FROM logs" --format table

SECURITY:
  - By default, only SELECT queries are allowed (readonly mode)
  - Database access is controlled via allowDatabases/denyDatabases config
  - Query results are limited to maxRows (default: 1000)
`;

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

/**
 * Check if a database path is allowed
 */
async function isDatabaseAllowed(dbPath: string): Promise<boolean> {
  // If allow list is empty, deny all unless default is set
  if (CONFIG.allowDatabases.length === 0 && !CONFIG.defaultDatabase) {
    return false;
  }

  // Check deny list first
  for (const pattern of CONFIG.denyDatabases) {
    const matches = await glob(pattern, { matchBase: true });
    if (matches.some((m) => m === dbPath || path.resolve(m) === path.resolve(dbPath))) {
      return false;
    }
  }

  // If allow list has "*", allow all (except denied)
  if (CONFIG.allowDatabases.includes("*")) {
    return true;
  }

  // Check allow list
  for (const pattern of CONFIG.allowDatabases) {
    const matches = await glob(pattern, { matchBase: true });
    if (matches.some((m) => m === dbPath || path.resolve(m) === path.resolve(dbPath))) {
      return true;
    }
  }

  // Check if exact path matches
  if (CONFIG.allowDatabases.includes(dbPath)) {
    return true;
  }

  return false;
}

/**
 * Validate that only SELECT queries are executed in readonly mode
 */
function isReadonlySafe(sql: string): boolean {
  const normalizedSql = sql.trim().toUpperCase();
  
  // Allow SELECT, PRAGMA (for schema), EXPLAIN
  const safePrefixes = ["SELECT", "PRAGMA", "EXPLAIN"];
  
  // Remove comments
  const sqlWithoutComments = normalizedSql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  
  return safePrefixes.some((prefix) => sqlWithoutComments.startsWith(prefix));
}

/**
 * Execute a SQL query and return results
 */
async function executeQuery(
  dbPath: string,
  sql: string,
  format: string,
  limit: number
): Promise<QueryResult> {
  // Use sqlite3 CLI with JSON output
  const result = await $`sqlite3 ${dbPath} -json -header ${sql}`.quiet();

  if (result.exitCode !== 0) {
    throw new Error(`SQLite error: ${result.stderr.toString()}`);
  }

  const output = result.stdout.toString().trim();
  
  if (!output) {
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  let rows: Record<string, unknown>[] = JSON.parse(output);
  const truncated = rows.length > limit;
  
  if (truncated) {
    rows = rows.slice(0, limit);
  }

  // Extract column names from first row
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return { columns, rows, rowCount: rows.length, truncated };
}

/**
 * Format query results
 */
function formatResult(result: QueryResult, format: string): string {
  switch (format) {
    case "table":
      if (result.rows.length === 0) {
        return "No results";
      }
      
      // Calculate column widths
      const widths: Record<string, number> = {};
      for (const col of result.columns) {
        widths[col] = col.length;
        for (const row of result.rows) {
          const val = String(row[col] ?? "");
          widths[col] = Math.max(widths[col], Math.min(val.length, 50));
        }
      }

      // Build table
      const lines: string[] = [];
      
      // Header
      const header = result.columns
        .map((col) => col.padEnd(widths[col]))
        .join(" | ");
      lines.push(header);
      lines.push("-".repeat(header.length));

      // Rows
      for (const row of result.rows) {
        const line = result.columns
          .map((col) => {
            const val = String(row[col] ?? "");
            return val.padEnd(widths[col]).slice(0, widths[col]);
          })
          .join(" | ");
        lines.push(line);
      }

      if (result.truncated) {
        lines.push(`... (truncated, showing ${result.rowCount} rows)`);
      }

      return lines.join("\n");

    case "csv":
      if (result.rows.length === 0) {
        return "";
      }
      
      const csvLines: string[] = [];
      csvLines.push(result.columns.join(","));
      
      for (const row of result.rows) {
        const values = result.columns.map((col) => {
          const val = row[col];
          if (val === null) return "";
          if (typeof val === "string" && (val.includes(",") || val.includes('"'))) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return String(val);
        });
        csvLines.push(values.join(","));
      }

      return csvLines.join("\n");

    case "json":
    default:
      const output = {
        ...result,
        truncated: result.truncated ? `Results limited to ${result.rowCount} rows` : undefined,
      };
      return JSON.stringify(output, null, 2);
  }
}

/**
 * List tables in a database
 */
async function listTables(dbPath: string, format: string): Promise<string> {
  const sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name";
  const result = await executeQuery(dbPath, sql, format, CONFIG.maxRows);
  return formatResult(result, format);
}

/**
 * Show schema for a table
 */
async function showSchema(
  dbPath: string,
  tableName: string | undefined,
  format: string
): Promise<string> {
  let sql: string;
  
  if (tableName) {
    sql = `SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`;
  } else {
    sql = "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view', 'index') ORDER BY name";
  }

  const result = await executeQuery(dbPath, sql, format, CONFIG.maxRows);
  return formatResult(result, format);
}

/**
 * Validate SQL syntax
 */
async function validateSql(sql: string): Promise<string> {
  // Use EXPLAIN to validate without executing
  try {
    const result = await $`sqlite3 :memory: "EXPLAIN ${sql}"`.quiet();
    
    if (result.exitCode === 0) {
      const isReadonly = isReadonlySafe(sql);
      return JSON.stringify({
        valid: true,
        readonlySafe: isReadonly,
        message: isReadonly
          ? "SQL is valid and safe for readonly mode"
          : "SQL is valid but would require write access",
      }, null, 2);
    } else {
      return JSON.stringify({
        valid: false,
        error: result.stderr.toString().trim(),
      }, null, 2);
    }
  } catch (error) {
    return JSON.stringify({
      valid: false,
      error: String(error),
    }, null, 2);
  }
}

/**
 * List allowed databases
 */
async function listAllowedDatabases(): Promise<string> {
  const databases: string[] = [];

  for (const pattern of CONFIG.allowDatabases) {
    if (pattern === "*") {
      databases.push("* (all databases allowed)");
    } else {
      const matches = await glob(pattern);
      databases.push(...matches);
    }
  }

  return JSON.stringify({
    allowed: databases,
    denied: CONFIG.denyDatabases,
    default: CONFIG.defaultDatabase || null,
    readonly: CONFIG.readonly,
    maxRows: CONFIG.maxRows,
  }, null, 2);
}

// Main entry point
async function main() {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: { type: "string", short: "d" },
      table: { type: "string", short: "t" },
      format: { type: "string", short: "f", default: "json" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const command = positionals[0];
  const limit = values.limit ? parseInt(values.limit, 10) : CONFIG.maxRows;

  // Handle databases command (doesn't need db path)
  if (command === "databases") {
    console.log(await listAllowedDatabases());
    return;
  }

  // Get database path
  const dbPath = values.db || CONFIG.defaultDatabase;
  if (!dbPath && command !== "validate") {
    console.error("Error: Database path required. Use --db or set defaultDatabase.");
    process.exit(1);
  }

  // Validate database access
  if (dbPath && !(await isDatabaseAllowed(dbPath))) {
    console.error(`Error: Database '${dbPath}' is not in the allowed list.`);
    process.exit(1);
  }

  // Handle commands
  switch (command) {
    case "query": {
      const sql = positionals[1];
      if (!sql) {
        console.error("Error: SQL query required.");
        process.exit(1);
      }

      // Check readonly safety
      if (CONFIG.readonly && !isReadonlySafe(sql)) {
        console.error("Error: Only SELECT queries are allowed in readonly mode.");
        console.error("Set SQLITE_READONLY=false to enable write operations.");
        process.exit(1);
      }

      const result = await executeQuery(dbPath!, sql, values.format || "json", limit);
      console.log(formatResult(result, values.format || "json"));
      break;
    }

    case "tables": {
      console.log(await listTables(dbPath!, values.format || "json"));
      break;
    }

    case "schema": {
      console.log(await showSchema(dbPath!, values.table, values.format || "json"));
      break;
    }

    case "validate": {
      const sql = positionals[1];
      if (!sql) {
        console.error("Error: SQL query required for validation.");
        process.exit(1);
      }
      console.log(await validateSql(sql));
      break;
    }

    default:
      console.error(`Error: Unknown command '${command}'`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
