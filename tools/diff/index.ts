#!/usr/bin/env bun
/**
 * Diff Tool - Compare files and directories
 *
 * Provides commands for:
 * - files: Compare two files
 * - dirs: Compare two directories
 * - text: Compare two text strings
 * - json: Compare two JSON objects
 * - lines: Compare two sets of lines
 */

interface DiffConfig {
  maxFileSize?: number;
  contextLines?: number;
  allowedPaths?: string[];
  deniedPaths?: string[];
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_CONTEXT_LINES = 3;

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

// Security check for paths
function checkPath(path: string, config: DiffConfig): void {
  const allowed = config.allowedPaths;
  const denied = config.deniedPaths;

  if (denied && denied.length > 0) {
    for (const d of denied) {
      if (path.startsWith(d)) {
        throw new Error(`Path is denied: ${path}`);
      }
    }
  }

  if (allowed && allowed.length > 0) {
    let isAllowed = false;
    for (const a of allowed) {
      if (path.startsWith(a)) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      throw new Error(`Path is not in allowed list: ${path}`);
    }
  }
}

// Read file with size check
async function readFile(path: string, config: DiffConfig): Promise<string> {
  checkPath(path, config);
  
  const stat = await Deno.stat(path);
  const maxSize = config.maxFileSize || DEFAULT_MAX_FILE_SIZE;
  
  if (stat.size > maxSize) {
    throw new Error(`File too large: ${path} (${stat.size} bytes, max: ${maxSize})`);
  }
  
  return await Deno.readTextFile(path);
}

// Diff algorithm (Longest Common Subsequence based)
interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLine?: number;
  newLine?: number;
}

function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff
  const result: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: "unchanged",
        content: oldLines[i - 1],
        oldLine: i,
        newLine: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: "added",
        content: newLines[j - 1],
        newLine: j,
      });
      j--;
    } else if (i > 0) {
      result.unshift({
        type: "removed",
        content: oldLines[i - 1],
        oldLine: i,
      });
      i--;
    }
  }

  return result;
}

// Format diff output
function formatDiff(diff: DiffLine[], contextLines: number, unified: boolean): string {
  const output: string[] = [];
  let i = 0;

  while (i < diff.length) {
    // Find next change block
    if (diff[i].type === "unchanged") {
      i++;
      continue;
    }

    // Find the extent of the change block
    let start = Math.max(0, i - contextLines);
    let end = i;
    while (end < diff.length && diff[end].type !== "unchanged") {
      end++;
    }
    end = Math.min(diff.length, end + contextLines);

    // Output header
    if (unified) {
      const oldStart = diff[start].oldLine || 1;
      const newStart = diff[start].newLine || 1;
      const oldCount = end - start;
      const newCount = end - start;
      output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    }

    // Output lines
    for (let j = start; j < end; j++) {
      const line = diff[j];
      switch (line.type) {
        case "added":
          output.push(`+ ${line.content}`);
          break;
        case "removed":
          output.push(`- ${line.content}`);
          break;
        case "unchanged":
          output.push(`  ${line.content}`);
          break;
      }
    }

    output.push("");
    i = end;
  }

  return output.join("\n");
}

// Count diff statistics
function countDiffStats(diff: DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0, removed = 0, unchanged = 0;
  for (const line of diff) {
    switch (line.type) {
      case "added": added++; break;
      case "removed": removed++; break;
      case "unchanged": unchanged++; break;
    }
  }
  return { added, removed, unchanged };
}

// Compare files
async function cmdFiles(
  file1: string,
  file2: string,
  options: Record<string, string | boolean>,
  config: DiffConfig
): Promise<string> {
  const content1 = await readFile(file1, config);
  const content2 = await readFile(file2, config);

  const lines1 = content1.split("\n");
  const lines2 = content2.split("\n");

  const diff = diffLines(lines1, lines2);
  const stats = countDiffStats(diff);

  const format = String(options.format || options.f || "unified");
  const contextLines = Number(options.context || options.c || config.contextLines || DEFAULT_CONTEXT_LINES);

  if (format === "json") {
    return JSON.stringify({
      file1,
      file2,
      stats,
      diff: diff,
    }, null, 2);
  }

  const output: string[] = [];
  output.push(`--- ${file1}`);
  output.push(`+++ ${file2}`);
  output.push("");
  output.push(formatDiff(diff, contextLines, format === "unified"));
  output.push("");
  output.push(`${stats.added} additions, ${stats.removed} deletions, ${stats.unchanged} unchanged`);

  return output.join("\n");
}

// Compare directories
async function cmdDirs(
  dir1: string,
  dir2: string,
  options: Record<string, string | boolean>,
  config: DiffConfig
): Promise<string> {
  checkPath(dir1, config);
  checkPath(dir2, config);

  const recursive = options.recursive || options.r;
  const showContent = options.content;

  // Get files in both directories
  async function getFiles(dir: string, base: string = ""): Promise<string[]> {
    const files: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        const relPath = base ? `${base}/${entry.name}` : entry.name;
        
        if (entry.isFile) {
          files.push(relPath);
        } else if (entry.isDirectory && recursive) {
          files.push(...await getFiles(path, relPath));
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return files;
  }

  const [files1, files2] = await Promise.all([
    getFiles(dir1),
    getFiles(dir2),
  ]);

  const set1 = new Set(files1);
  const set2 = new Set(files2);

  const onlyIn1 = files1.filter(f => !set2.has(f)).sort();
  const onlyIn2 = files2.filter(f => !set1.has(f)).sort();
  const common = files1.filter(f => set2.has(f)).sort();

  // Compare common files
  const changed: { file: string; added: number; removed: number }[] = [];
  const unchanged: string[] = [];

  for (const file of common) {
    try {
      const content1 = await readFile(`${dir1}/${file}`, config);
      const content2 = await readFile(`${dir2}/${file}`, config);
      
      if (content1 === content2) {
        unchanged.push(file);
      } else {
        const diff = diffLines(content1.split("\n"), content2.split("\n"));
        const stats = countDiffStats(diff);
        changed.push({ file, added: stats.added, removed: stats.removed });
      }
    } catch {
      // Can't compare binary or unreadable files
      unchanged.push(file);
    }
  }

  const format = String(options.format || options.f || "summary");

  if (format === "json") {
    return JSON.stringify({
      dir1,
      dir2,
      onlyInDir1: onlyIn1,
      onlyInDir2: onlyIn2,
      changed,
      unchanged,
      stats: {
        added: onlyIn2.length,
        removed: onlyIn1.length,
        changed: changed.length,
        unchanged: unchanged.length,
      },
    }, null, 2);
  }

  const output: string[] = [];
  
  output.push(`Comparing directories:`);
  output.push(`  ${dir1}`);
  output.push(`  ${dir2}`);
  output.push("");

  if (onlyIn1.length > 0) {
    output.push(`Only in ${dir1}:`);
    for (const f of onlyIn1) {
      output.push(`  - ${f}`);
    }
    output.push("");
  }

  if (onlyIn2.length > 0) {
    output.push(`Only in ${dir2}:`);
    for (const f of onlyIn2) {
      output.push(`  + ${f}`);
    }
    output.push("");
  }

  if (changed.length > 0) {
    output.push("Changed files:");
    for (const c of changed) {
      output.push(`  ~ ${c.file} (+${c.added}/-${c.removed})`);
    }
    output.push("");
  }

  output.push(`Summary: ${onlyIn1.length} removed, ${onlyIn2.length} added, ${changed.length} changed, ${unchanged.length} unchanged`);

  return output.join("\n");
}

// Compare text strings
function cmdText(
  text1: string,
  text2: string,
  options: Record<string, string | boolean>,
  config: DiffConfig
): string {
  const lines1 = text1.split("\n");
  const lines2 = text2.split("\n");

  const diff = diffLines(lines1, lines2);
  const stats = countDiffStats(diff);

  const format = String(options.format || options.f || "unified");
  const contextLines = Number(options.context || options.c || config.contextLines || DEFAULT_CONTEXT_LINES);

  if (format === "json") {
    return JSON.stringify({
      stats,
      diff,
    }, null, 2);
  }

  const output: string[] = [];
  output.push("--- text1");
  output.push("+++ text2");
  output.push("");
  output.push(formatDiff(diff, contextLines, format === "unified"));
  output.push("");
  output.push(`${stats.added} additions, ${stats.removed} deletions, ${stats.unchanged} unchanged`);

  return output.join("\n");
}

// Compare JSON objects
function cmdJson(
  json1: string,
  json2: string,
  options: Record<string, string | boolean>,
  config: DiffConfig
): string {
  let obj1: unknown, obj2: unknown;
  
  try {
    obj1 = JSON.parse(json1);
  } catch (e) {
    throw new Error(`Invalid JSON in first argument: ${(e as Error).message}`);
  }
  
  try {
    obj2 = JSON.parse(json2);
  } catch (e) {
    throw new Error(`Invalid JSON in second argument: ${(e as Error).message}`);
  }

  const format = String(options.format || options.f || "summary");

  // Deep comparison
  function deepCompare(a: unknown, b: unknown, path: string = ""): { type: string; path: string; details?: string }[] {
    const result: { type: string; path: string; details?: string }[] = [];

    if (typeof a !== typeof b) {
      result.push({ type: "type-change", path, details: `${typeof a} -> ${typeof b}` });
      return result;
    }

    if (a === null || b === null) {
      if (a !== b) {
        result.push({ type: "value-change", path, details: `${a} -> ${b}` });
      }
      return result;
    }

    if (typeof a !== "object") {
      if (a !== b) {
        result.push({ type: "value-change", path, details: `${JSON.stringify(a)} -> ${JSON.stringify(b)}` });
      }
      return result;
    }

    if (Array.isArray(a) !== Array.isArray(b)) {
      result.push({ type: "type-change", path, details: Array.isArray(a) ? "array -> object" : "object -> array" });
      return result;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        const newPath = `${path}[${i}]`;
        if (i >= a.length) {
          result.push({ type: "added", path: newPath, details: JSON.stringify(b[i]) });
        } else if (i >= b.length) {
          result.push({ type: "removed", path: newPath, details: JSON.stringify(a[i]) });
        } else {
          result.push(...deepCompare(a[i], b[i], newPath));
        }
      }
      return result;
    }

    // Both are objects
    const keys1 = Object.keys(a as Record<string, unknown>);
    const keys2 = Object.keys(b as Record<string, unknown>);
    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const newPath = path ? `${path}.${key}` : key;
      const objA = a as Record<string, unknown>;
      const objB = b as Record<string, unknown>;
      
      if (!(key in objA)) {
        result.push({ type: "added", path: newPath, details: JSON.stringify(objB[key]) });
      } else if (!(key in objB)) {
        result.push({ type: "removed", path: newPath, details: JSON.stringify(objA[key]) });
      } else {
        result.push(...deepCompare(objA[key], objB[key], newPath));
      }
    }

    return result;
  }

  const differences = deepCompare(obj1, obj2);

  if (format === "json") {
    return JSON.stringify({
      equal: differences.length === 0,
      differences,
    }, null, 2);
  }

  if (differences.length === 0) {
    return "JSON objects are equal";
  }

  const output: string[] = [];
  output.push(`Found ${differences.length} differences:`);
  output.push("");

  for (const diff of differences) {
    const icon = diff.type === "added" ? "+" : diff.type === "removed" ? "-" : "~";
    output.push(`  ${icon} ${diff.path}: ${diff.details || diff.type}`);
  }

  return output.join("\n");
}

// Compare line sets (ignoring order)
function cmdLines(
  text1: string,
  text2: string,
  options: Record<string, string | boolean>,
  config: DiffConfig
): string {
  const lines1 = text1.split("\n").filter(l => l.trim() || !options["ignore-empty"]);
  const lines2 = text2.split("\n").filter(l => l.trim() || !options["ignore-empty"]);

  const set1 = new Set(lines1);
  const set2 = new Set(lines2);

  const onlyIn1 = lines1.filter(l => !set2.has(l));
  const onlyIn2 = lines2.filter(l => !set1.has(l));
  const common = lines1.filter(l => set2.has(l));

  const format = String(options.format || options.f || "summary");

  if (format === "json") {
    return JSON.stringify({
      onlyInFirst: onlyIn1,
      onlyInSecond: onlyIn2,
      common,
      stats: {
        onlyInFirst: onlyIn1.length,
        onlyInSecond: onlyIn2.length,
        common: common.length,
      },
    }, null, 2);
  }

  const output: string[] = [];
  
  output.push("Line set comparison:");
  output.push("");

  if (onlyIn1.length > 0) {
    output.push(`Only in first (${onlyIn1.length}):`);
    for (const l of onlyIn1) {
      output.push(`  - ${l}`);
    }
    output.push("");
  }

  if (onlyIn2.length > 0) {
    output.push(`Only in second (${onlyIn2.length}):`);
    for (const l of onlyIn2) {
      output.push(`  + ${l}`);
    }
    output.push("");
  }

  output.push(`Common: ${common.length} lines`);

  return output.join("\n");
}

function showHelp(): string {
  return `
Diff Tool - Compare files and directories

USAGE:
  diff <command> [options] [arguments]

COMMANDS:
  files <file1> <file2>    Compare two files
    --format, -f <format>  Output format: unified, json
    --context, -c <n>      Context lines (default: 3)

  dirs <dir1> <dir2>       Compare two directories
    --recursive, -r        Compare subdirectories
    --content              Show content diff for changed files
    --format, -f <format>  Output format: summary, json

  text <text1> <text2>     Compare two text strings
    --format, -f <format>  Output format: unified, json
    --context, -c <n>      Context lines (default: 3)

  json <json1> <json2>     Compare two JSON objects
    --format, -f <format>  Output format: summary, json

  lines <text1> <text2>    Compare two sets of lines (ignoring order)
    --ignore-empty         Ignore empty lines
    --format, -f <format>  Output format: summary, json

EXAMPLES:
  diff files old.txt new.txt
  diff files file1.ts file2.ts -c 5
  diff dirs src/ dist/ -r
  diff text "hello world" "hello there"
  diff json '{"a":1}' '{"a":2}'
  diff lines "a\\nb\\nc" "b\\nc\\nd"
`;
}

async function main(args: string[], config: DiffConfig = {}): Promise<string> {
  const { command, options, positional } = parseArgs(args);

  switch (command) {
    case "":
    case "help":
    case "--help":
    case "-h":
      return showHelp();

    case "files":
    case "file":
      if (positional.length < 2) {
        throw new Error("files requires two file paths");
      }
      return cmdFiles(positional[0], positional[1], options, config);

    case "dirs":
    case "dir":
    case "directories":
      if (positional.length < 2) {
        throw new Error("dirs requires two directory paths");
      }
      return cmdDirs(positional[0], positional[1], options, config);

    case "text":
    case "string":
      if (positional.length < 2) {
        throw new Error("text requires two text strings");
      }
      return cmdText(positional[0], positional[1], options, config);

    case "json":
      if (positional.length < 2) {
        throw new Error("json requires two JSON strings");
      }
      return cmdJson(positional[0], positional[1], options, config);

    case "lines":
      if (positional.length < 2) {
        throw new Error("lines requires two text strings");
      }
      return cmdLines(positional[0], positional[1], options, config);

    default:
      throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

// Run if called directly
if (import.meta.main) {
  const args = Deno.args;
  const config: DiffConfig = {
    maxFileSize: parseInt(Deno.env.get("DIFF_MAX_FILE_SIZE") || "10485760"),
    contextLines: parseInt(Deno.env.get("DIFF_CONTEXT_LINES") || "3"),
  };

  main(args, config)
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      Deno.exit(1);
    });
}

export { main as diffTool, diffLines, formatDiff, countDiffStats };
