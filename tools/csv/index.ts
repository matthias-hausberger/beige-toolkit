#!/usr/bin/env node
/**
 * CSV Tool - Parse, query, and manipulate CSV/TSV files
 * 
 * Commands:
 *   read     - Read and display CSV file contents
 *   write    - Create CSV file from JSON data
 *   query    - Query CSV with SQL-like syntax
 *   convert  - Convert between CSV, TSV, JSON formats
 *   stats    - Get statistics about CSV file
 *   validate - Validate CSV structure
 *   head     - Show first N rows
 *   tail     - Show last N rows
 *   select   - Select specific columns
 *   filter   - Filter rows by condition
 *   sort     - Sort rows by column
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

// Configuration
const CONFIG = {
  maxFileSize: parseInt(process.env.CSV_MAX_FILE_SIZE || "52428800", 10), // 50MB
  maxRows: parseInt(process.env.CSV_MAX_ROWS || "10000", 10),
  pathAllowList: process.env.CSV_PATH_ALLOW_LIST?.split(",").filter(Boolean) || [],
  pathDenyList: process.env.CSV_PATH_DENY_LIST?.split(",").filter(Boolean) || [],
};

interface CsvRow {
  [key: string]: string;
}

interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
  rowCount: number;
  columnCount: number;
}

interface Stats {
  file: string;
  fileSize: number;
  rowCount: number;
  columnCount: number;
  columns: ColumnStats[];
}

interface ColumnStats {
  name: string;
  type: "string" | "number" | "boolean" | "mixed" | "empty";
  emptyCount: number;
  uniqueCount: number;
  sampleValues: string[];
}

// Output helpers
function output(data: unknown, format = "json"): void {
  switch (format) {
    case "json":
      console.log(JSON.stringify(data, null, 2));
      break;
    case "csv":
      console.log(formatAsCsv(data));
      break;
    case "table":
      console.log(formatAsTable(data));
      break;
    default:
      console.log(JSON.stringify(data, null, 2));
  }
}

function formatAsCsv(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) return "";
  const rows = Array.isArray(data[0]) ? data : [Object.keys(data[0] as CsvRow), ...data.map(r => Object.values(r as CsvRow))];
  return rows.map(row => 
    row.map(cell => {
      const str = String(cell ?? "");
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(",")
  ).join("\n");
}

function formatAsTable(data: unknown): string {
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    const rows = data as CsvRow[];
    const headers = Object.keys(rows[0]);
    const colWidths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? "").length)));
    
    const border = "+" + colWidths.map(w => "-".repeat(w + 2)).join("+") + "+";
    const headerRow = "| " + headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ") + " |";
    const separator = "|" + colWidths.map(w => "-".repeat(w + 2)).join("|") + "|";
    const dataRows = rows.slice(0, 50).map(r => 
      "| " + headers.map((h, i) => String(r[h] ?? "").padEnd(colWidths[i])).join(" | ") + " |"
    ).join("\n");
    
    return [border, headerRow, separator, ...dataRows.slice(0, 50), border].join("\n");
  }
  return JSON.stringify(data, null, 2);
}

function error(message: string, code = 1): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(code);
}

// Security: Validate path access
function validatePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  
  // Check deny list
  for (const denied of CONFIG.pathDenyList) {
    if (resolved.includes(denied) || path.match(resolved, denied)) {
      error(`Access denied: path matches deny list pattern`);
    }
  }
  
  // If allow list is set, path must match at least one
  if (CONFIG.pathAllowList.length > 0) {
    const allowed = CONFIG.pathAllowList.some(pattern => 
      resolved.includes(pattern) || path.match(resolved, pattern)
    );
    if (!allowed) {
      error(`Access denied: path does not match any allow list pattern`);
    }
  }
  
  return resolved;
}

// Parse CSV/TSV content
function parseCsv(content: string, delimiter = ",", hasHeader = true): ParsedCsv {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) {
    return { headers: [], rows: [], rowCount: 0, columnCount: 0 };
  }
  
  // Parse CSV line respecting quotes
  function parseLine(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  }
  
  const parsedLines = lines.map(parseLine);
  const columnCount = Math.max(...parsedLines.map(l => l.length));
  
  let headers: string[];
  let dataLines: string[][];
  
  if (hasHeader) {
    headers = parsedLines[0].map(h => h.trim());
    dataLines = parsedLines.slice(1);
  } else {
    headers = Array.from({ length: columnCount }, (_, i) => `col_${i}`);
    dataLines = parsedLines;
  }
  
  // Pad headers if needed
  while (headers.length < columnCount) {
    headers.push(`col_${headers.length}`);
  }
  
  const rows = dataLines.slice(0, CONFIG.maxRows).map(line => {
    const row: CsvRow = {};
    headers.forEach((header, i) => {
      row[header] = line[i]?.trim() ?? "";
    });
    return row;
  });
  
  return {
    headers,
    rows,
    rowCount: rows.length,
    columnCount
  };
}

// Convert rows to CSV string
function toCsv(rows: CsvRow[], delimiter = ","): string {
  if (rows.length === 0) return "";
  
  const headers = Object.keys(rows[0]);
  const lines: string[] = [];
  
  // Header line
  lines.push(headers.map(h => {
    if (h.includes(delimiter) || h.includes('"') || h.includes("\n")) {
      return `"${h.replace(/"/g, '""')}"`;
    }
    return h;
  }).join(delimiter));
  
  // Data lines
  for (const row of rows) {
    const values = headers.map(h => {
      const val = String(row[h] ?? "");
      if (val.includes(delimiter) || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    lines.push(values.join(delimiter));
  }
  
  return lines.join("\n");
}

// Detect column type
function detectColumnType(values: string[]): ColumnStats["type"] {
  const nonEmpty = values.filter(v => v.trim() !== "");
  if (nonEmpty.length === 0) return "empty";
  
  let hasNumber = false;
  let hasBoolean = false;
  let hasString = false;
  
  for (const val of nonEmpty) {
    if (/^-?\d+\.?\d*$/.test(val)) {
      hasNumber = true;
    } else if (val.toLowerCase() === "true" || val.toLowerCase() === "false") {
      hasBoolean = true;
    } else {
      hasString = true;
    }
  }
  
  if (hasString) return "string";
  if (hasNumber && hasBoolean) return "mixed";
  if (hasNumber) return "number";
  if (hasBoolean) return "boolean";
  return "string";
}

// Commands

function cmdRead(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const hasHeader = options.noHeader !== true;
  const format = String(options.format || "json");
  const limit = parseInt(String(options.limit || CONFIG.maxRows), 10);
  const offset = parseInt(String(options.offset || "0"), 10);
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const stats = fs.statSync(validatedPath);
  if (stats.size > CONFIG.maxFileSize) {
    error(`File too large: ${stats.size} bytes (max: ${CONFIG.maxFileSize})`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const parsed = parseCsv(content, delimiter, hasHeader);
  
  const result = {
    file: filePath,
    headers: parsed.headers,
    rowCount: parsed.rowCount,
    columnCount: parsed.columnCount,
    rows: parsed.rows.slice(offset, offset + limit)
  };
  
  output(result, format);
}

function cmdWrite(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const data = options.data ? JSON.parse(String(options.data)) : null;
  const append = options.append === true;
  
  if (!data) {
    error("Missing required option: --data");
  }
  
  let rows: CsvRow[];
  if (Array.isArray(data)) {
    rows = data;
  } else {
    error("Data must be an array of objects");
  }
  
  const csvContent = toCsv(rows, delimiter);
  
  if (append && fs.existsSync(validatedPath)) {
    // Append without header
    const existing = fs.readFileSync(validatedPath, "utf-8");
    const newContent = existing.trimEnd() + "\n" + csvContent.split("\n").slice(1).join("\n");
    fs.writeFileSync(validatedPath, newContent);
  } else {
    fs.writeFileSync(validatedPath, csvContent);
  }
  
  output({ success: true, file: filePath, rowsWritten: rows.length });
}

function cmdQuery(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const hasHeader = options.noHeader !== true;
  const format = String(options.format || "json");
  const selectCol = String(options.select || "").split(",").filter(Boolean);
  const where = String(options.where || "");
  const orderBy = String(options.orderBy || "");
  const orderDir = String(options.orderDir || "asc");
  const limit = parseInt(String(options.limit || CONFIG.maxRows), 10);
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { headers, rows } = parseCsv(content, delimiter, hasHeader);
  
  let result = [...rows];
  
  // Filter
  if (where) {
    const [col, op, ...valParts] = where.split(/\s+/);
    const val = valParts.join(" ");
    
    result = result.filter(row => {
      const cellValue = row[col];
      if (!cellValue) return false;
      
      switch (op) {
        case "=":
        case "==":
          return cellValue === val;
        case "!=":
          return cellValue !== val;
        case ">":
          return parseFloat(cellValue) > parseFloat(val);
        case "<":
          return parseFloat(cellValue) < parseFloat(val);
        case ">=":
          return parseFloat(cellValue) >= parseFloat(val);
        case "<=":
          return parseFloat(cellValue) <= parseFloat(val);
        case "~":
          return new RegExp(val, "i").test(cellValue);
        case "!~":
          return !new RegExp(val, "i").test(cellValue);
        default:
          return false;
      }
    });
  }
  
  // Sort
  if (orderBy) {
    result.sort((a, b) => {
      const aVal = a[orderBy] || "";
      const bVal = b[orderBy] || "";
      const aNum = parseFloat(aVal);
      const bNum = parseFloat(bVal);
      
      let cmp: number;
      if (!isNaN(aNum) && !isNaN(bNum)) {
        cmp = aNum - bNum;
      } else {
        cmp = aVal.localeCompare(bVal);
      }
      
      return orderDir === "desc" ? -cmp : cmp;
    });
  }
  
  // Select columns
  if (selectCol.length > 0) {
    result = result.map(row => {
      const newRow: CsvRow = {};
      for (const col of selectCol) {
        if (col in row) {
          newRow[col] = row[col];
        }
      }
      return newRow;
    });
  }
  
  output({
    file: filePath,
    rowCount: result.length,
    rows: result.slice(0, limit)
  }, format);
}

function cmdConvert(inputPath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(inputPath);
  const from = String(options.from || "csv");
  const to = String(options.to || "json");
  const delimiter = String(options.delimiter || from === "tsv" ? "\t" : ",");
  const outputPath = String(options.output || "");
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${inputPath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { headers, rows } = parseCsv(content, delimiter, true);
  
  let result: string;
  let mimeType: string;
  
  switch (to) {
    case "json":
      result = JSON.stringify(rows, null, 2);
      mimeType = "application/json";
      break;
    case "jsonl":
      result = rows.map(r => JSON.stringify(r)).join("\n");
      mimeType = "application/x-ndjson";
      break;
    case "csv":
      result = toCsv(rows, ",");
      mimeType = "text/csv";
      break;
    case "tsv":
      result = toCsv(rows, "\t");
      mimeType = "text/tab-separated-values";
      break;
    case "md":
    case "markdown":
      result = formatAsMarkdownTable(headers, rows);
      mimeType = "text/markdown";
      break;
    default:
      error(`Unsupported output format: ${to}`);
  }
  
  if (outputPath) {
    const outPath = validatePath(outputPath);
    fs.writeFileSync(outPath, result);
    output({ success: true, input: inputPath, output: outputPath, format: to, rows: rows.length });
  } else {
    console.log(result);
  }
}

function formatAsMarkdownTable(headers: string[], rows: CsvRow[]): string {
  const lines: string[] = [];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");
  for (const row of rows) {
    lines.push("| " + headers.map(h => row[h] ?? "").join(" | ") + " |");
  }
  return lines.join("\n");
}

function cmdStats(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const hasHeader = options.noHeader !== true;
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const stats = fs.statSync(validatedPath);
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { headers, rows } = parseCsv(content, delimiter, hasHeader);
  
  const columnStats: ColumnStats[] = headers.map(header => {
    const values = rows.map(r => r[header] || "");
    const nonEmpty = values.filter(v => v.trim() !== "");
    const unique = new Set(nonEmpty);
    
    return {
      name: header,
      type: detectColumnType(values),
      emptyCount: values.length - nonEmpty.length,
      uniqueCount: unique.size,
      sampleValues: nonEmpty.slice(0, 5)
    };
  });
  
  const result: Stats = {
    file: filePath,
    fileSize: stats.size,
    rowCount: rows.length,
    columnCount: headers.length,
    columns: columnStats
  };
  
  output(result);
}

function cmdValidate(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const lines = content.split(/\r?\n/);
  
  const issues: Array<{ line: number; message: string }> = [];
  let columnCount = 0;
  
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    
    // Count columns (simple, doesn't handle quotes)
    const inQuotes = (line.match(/"/g) || []).length % 2 === 1;
    if (inQuotes) {
      issues.push({ line: i + 1, message: "Unclosed quote" });
    }
    
    // Count delimiters (rough estimate)
    const cols = line.split(delimiter).length;
    if (i === 0) {
      columnCount = cols;
    } else if (cols !== columnCount) {
      issues.push({ line: i + 1, message: `Column count mismatch: expected ${columnCount}, got ${cols}` });
    }
  });
  
  output({
    file: filePath,
    valid: issues.length === 0,
    lineCount: lines.filter(l => l.trim()).length,
    columnCount,
    issues: issues.slice(0, 50)
  });
}

function cmdHead(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const hasHeader = options.noHeader !== true;
  const n = parseInt(String(options.n || "10"), 10);
  const format = String(options.format || "table");
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { headers, rows } = parseCsv(content, delimiter, hasHeader);
  
  output({
    headers,
    rows: rows.slice(0, n)
  }, format);
}

function cmdTail(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const hasHeader = options.noHeader !== true;
  const n = parseInt(String(options.n || "10"), 10);
  const format = String(options.format || "table");
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { headers, rows } = parseCsv(content, delimiter, hasHeader);
  
  output({
    headers,
    rows: rows.slice(-n)
  }, format);
}

function cmdSelect(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const columns = String(options.columns || "").split(",").filter(Boolean);
  const format = String(options.format || "csv");
  
  if (columns.length === 0) {
    error("Missing required option: --columns");
  }
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { rows } = parseCsv(content, delimiter, true);
  
  const selected = rows.map(row => {
    const newRow: CsvRow = {};
    for (const col of columns) {
      newRow[col] = row[col] ?? "";
    }
    return newRow;
  });
  
  output(selected, format);
}

function cmdFilter(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const column = String(options.column || "");
  const operator = String(options.operator || "=");
  const value = String(options.value || "");
  const format = String(options.format || "csv");
  
  if (!column || !value) {
    error("Missing required options: --column and --value");
  }
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { rows } = parseCsv(content, delimiter, true);
  
  const filtered = rows.filter(row => {
    const cellValue = row[column] || "";
    switch (operator) {
      case "=":
      case "==":
        return cellValue === value;
      case "!=":
        return cellValue !== value;
      case "~":
        return new RegExp(value, "i").test(cellValue);
      case "!~":
        return !new RegExp(value, "i").test(cellValue);
      case ">":
        return parseFloat(cellValue) > parseFloat(value);
      case "<":
        return parseFloat(cellValue) < parseFloat(value);
      default:
        return cellValue === value;
    }
  });
  
  output(filtered, format);
}

function cmdSort(filePath: string, options: Record<string, unknown>): void {
  const validatedPath = validatePath(filePath);
  const delimiter = String(options.delimiter || ",");
  const column = String(options.column || "");
  const direction = String(options.direction || "asc");
  const format = String(options.format || "csv");
  
  if (!column) {
    error("Missing required option: --column");
  }
  
  if (!fs.existsSync(validatedPath)) {
    error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(validatedPath, "utf-8");
  const { rows } = parseCsv(content, delimiter, true);
  
  const sorted = [...rows].sort((a, b) => {
    const aVal = a[column] || "";
    const bVal = b[column] || "";
    const aNum = parseFloat(aVal);
    const bNum = parseFloat(bVal);
    
    let cmp: number;
    if (!isNaN(aNum) && !isNaN(bNum)) {
      cmp = aNum - bNum;
    } else {
      cmp = aVal.localeCompare(bVal);
    }
    
    return direction === "desc" ? -cmp : cmp;
  });
  
  output(sorted, format);
}

// Main CLI
const { positionals, values: options } = parseArgs({
  options: {
    // General options
    delimiter: { type: "string", short: "d" },
    format: { type: "string", short: "f" },
    output: { type: "string", short: "o" },
    limit: { type: "string" },
    offset: { type: "string" },
    "no-header": { type: "boolean" },
    
    // Read/write options
    data: { type: "string" },
    append: { type: "boolean" },
    
    // Query options
    select: { type: "string" },
    where: { type: "string", short: "w" },
    orderBy: { type: "string" },
    orderDir: { type: "string" },
    
    // Convert options
    from: { type: "string" },
    to: { type: "string" },
    
    // Filter options
    column: { type: "string", short: "c" },
    operator: { type: "string", short: "O" },
    value: { type: "string", short: "v" },
    
    // Sort options
    direction: { type: "string" },
    
    // Head/tail options
    n: { type: "string" },
    
    // Select options
    columns: { type: "string" },
    
    // Help
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];
const filePath = positionals[1];

if (options.help || !command) {
  console.log(`
CSV Tool - Parse, query, and manipulate CSV/TSV files

Commands:
  read <file>              Read and display CSV file contents
  write <file>             Create CSV file from JSON data
  query <file>             Query CSV with SQL-like syntax
  convert <file>           Convert between CSV, TSV, JSON formats
  stats <file>             Get statistics about CSV file
  validate <file>          Validate CSV structure
  head <file>              Show first N rows
  tail <file>              Show last N rows
  select <file>            Select specific columns
  filter <file>            Filter rows by condition
  sort <file>              Sort rows by column

Options:
  -d, --delimiter <char>   Field delimiter (default: comma)
  -f, --format <fmt>       Output format: json, csv, table (default: json)
  -o, --output <file>      Output file (for convert)
  --no-header              File has no header row
  --limit <n>              Limit number of rows
  --offset <n>             Skip first N rows
  --data <json>            JSON data for write command
  --append                 Append to existing file
  --select <cols>          Select columns (comma-separated)
  -w, --where <expr>       Filter expression: "col op value"
  --orderBy <col>          Sort by column
  --orderDir <dir>         Sort direction: asc, desc
  --from <fmt>             Input format: csv, tsv
  --to <fmt>               Output format: json, jsonl, csv, tsv, md
  -c, --column <name>      Column for filter/sort
  -O, --operator <op>      Filter operator: =, !=, >, <, ~, !~
  -v, --value <val>        Filter value
  --direction <dir>        Sort direction: asc, desc
  --columns <cols>         Columns to select (comma-separated)
  -n <count>               Number of rows for head/tail
  -h, --help               Show this help

Examples:
  csv read data.csv
  csv read data.tsv --delimiter "\\t"
  csv query data.csv --where "age > 30" --select "name,age"
  csv convert data.csv --to json
  csv stats data.csv
  csv filter data.csv --column status --value active
  csv sort data.csv --column age --direction desc
  csv write output.csv --data '[{"name":"Alice","age":30}]'
`);
  process.exit(0);
}

// Execute command
switch (command) {
  case "read":
    if (!filePath) error("Missing file path");
    cmdRead(filePath, options);
    break;
  case "write":
    if (!filePath) error("Missing file path");
    cmdWrite(filePath, options);
    break;
  case "query":
    if (!filePath) error("Missing file path");
    cmdQuery(filePath, options);
    break;
  case "convert":
    if (!filePath) error("Missing file path");
    cmdConvert(filePath, options);
    break;
  case "stats":
    if (!filePath) error("Missing file path");
    cmdStats(filePath, options);
    break;
  case "validate":
    if (!filePath) error("Missing file path");
    cmdValidate(filePath, options);
    break;
  case "head":
    if (!filePath) error("Missing file path");
    cmdHead(filePath, options);
    break;
  case "tail":
    if (!filePath) error("Missing file path");
    cmdTail(filePath, options);
    break;
  case "select":
    if (!filePath) error("Missing file path");
    cmdSelect(filePath, options);
    break;
  case "filter":
    if (!filePath) error("Missing file path");
    cmdFilter(filePath, options);
    break;
  case "sort":
    if (!filePath) error("Missing file path");
    cmdSort(filePath, options);
    break;
  default:
    error(`Unknown command: ${command}`);
}
