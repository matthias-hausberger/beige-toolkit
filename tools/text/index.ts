#!/usr/bin/env node
/**
 * Text Tool - Text processing, transformation, and analysis
 * 
 * Commands:
 *   transform  - Apply text transformations (trim, normalize, escape)
 *   case       - Change text case (upper, lower, title, camel, snake, etc.)
 *   template   - Apply template substitutions
 *   count      - Count characters, words, lines, bytes
 *   extract    - Extract patterns (emails, URLs, numbers, etc.)
 *   replace    - Find and replace text
 *   trim       - Trim whitespace from lines
 *   pad        - Pad text to width
 *   wrap       - Wrap text to column width
 *   align      - Align text (left, right, center)
 *   sort       - Sort lines
 *   unique     - Remove duplicate lines
 *   reverse    - Reverse text or lines
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";

// Configuration
const CONFIG = {
  maxInputSize: parseInt(process.env.TEXT_MAX_INPUT_SIZE || "10485760", 10), // 10MB
  defaultEncoding: process.env.TEXT_DEFAULT_ENCODING || "utf-8",
};

// Output helpers
function output(data: unknown): void {
  if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function error(message: string, code = 1): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(code);
}

function readInput(options: Record<string, unknown>): string {
  const file = options.file as string | undefined;
  const text = options.text as string | undefined;
  
  if (text !== undefined) {
    return text;
  }
  
  if (file) {
    if (!fs.existsSync(file)) {
      error(`File not found: ${file}`);
    }
    const stats = fs.statSync(file);
    if (stats.size > CONFIG.maxInputSize) {
      error(`File too large: ${stats.size} bytes (max: ${CONFIG.maxInputSize})`);
    }
    return fs.readFileSync(file, CONFIG.defaultEncoding);
  }
  
  // Read from stdin if no input provided
  if (!process.stdin.isTTY) {
    let data = "";
    process.stdin.setEncoding(CONFIG.defaultEncoding);
    // Synchronous read for simplicity
    const fd = 0;
    const buffer = Buffer.alloc(CONFIG.maxInputSize);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString(CONFIG.defaultEncoding, 0, bytesRead);
  }
  
  error("No input provided. Use --text or --file");
}

// Case transformations
const caseTransforms: Record<string, (s: string) => string> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.replace(/\b\w/g, c => c.toUpperCase()),
  sentence: (s) => s.replace(/(^\s*\w|[.!?]\s*\w)/g, c => c.toUpperCase()),
  camel: (s) => s.replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toLowerCase()),
  pascal: (s) => s.replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toUpperCase()),
  snake: (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase(),
  kebab: (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase(),
  constant: (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toUpperCase(),
  dot: (s) => s.replace(/([a-z])([A-Z])/g, '$1.$2').replace(/[-_\s]+/g, '.').toLowerCase(),
  path: (s) => s.replace(/([a-z])([A-Z])/g, '$1/$2').replace(/[-_\s]+/g, '/').toLowerCase(),
  train: (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase().replace(/(^|-)(\w)/g, (_, s, c) => s + c.toUpperCase()),
  header: (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase().replace(/(^|-)(\w)/g, (_, s, c) => s + c.toUpperCase()),
};

// Extract patterns
const extractPatterns: Record<string, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  url: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
  phone: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  ipv4: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  ipv6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
  number: /-?\d+\.?\d*/g,
  integer: /-?\d+/g,
  float: /-?\d+\.\d+/g,
  hex: /#?[0-9a-fA-F]{6,8}\b/g,
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  date: /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}/g,
  time: /\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?/gi,
  word: /\b\w+\b/g,
  line: /.+/g,
};

// Commands

function cmdCase(options: Record<string, unknown>): void {
  const text = readInput(options);
  const to = String(options.to || "lower");
  
  const transform = caseTransforms[to];
  if (!transform) {
    error(`Unknown case: ${to}. Available: ${Object.keys(caseTransforms).join(", ")}`);
  }
  
  output(transform(text));
}

function cmdTransform(options: Record<string, unknown>): void {
  let text = readInput(options);
  const ops = String(options.ops || "").split(",").filter(Boolean);
  
  if (ops.length === 0) {
    error("Missing --ops option. Available: trim, normalize, escape, unescape, urlencode, urldecode, base64encode, base64decode, htmlencode, htmldecode, strip, compact, dedent, indent");
  }
  
  const transformers: Record<string, (s: string) => string> = {
    trim: (s) => s.trim(),
    ltrim: (s) => s.trimStart(),
    rtrim: (s) => s.trimEnd(),
    normalize: (s) => s.normalize("NFC"),
    nfc: (s) => s.normalize("NFC"),
    nfd: (s) => s.normalize("NFD"),
    nfkc: (s) => s.normalize("NFKC"),
    nfkd: (s) => s.normalize("NFKD"),
    escape: (s) => s.replace(/[\\\"'\n\r\t]/g, c => ({ "\\": "\\\\", "\"": "\\\"", "'": "\\'", "\n": "\\n", "\r": "\\r", "\t": "\\t" }[c] || c)),
    unescape: (s) => s.replace(/\\([\\"'nrt])/g, (_, c) => ({ "\\": "\\", "\"": "\"", "'": "'", "n": "\n", "r": "\r", "t": "\t" }[c] || c)),
    urlencode: (s) => encodeURIComponent(s),
    urldecode: (s) => decodeURIComponent(s),
    base64encode: (s) => Buffer.from(s).toString("base64"),
    base64decode: (s) => Buffer.from(s, "base64").toString(),
    htmlencode: (s) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] || c)),
    htmldecode: (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" }[e] || e)),
    strip: (s) => s.replace(/<[^>]*>/g, ""),
    compact: (s) => s.replace(/\n{3,}/g, "\n\n"),
    dedent: (s) => {
      const lines = s.split("\n");
      const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)?.[0].length || 0));
      return lines.map(l => l.slice(minIndent)).join("\n");
    },
    indent: (s) => s.split("\n").map(l => "  " + l).join("\n"),
  };
  
  for (const op of ops) {
    const transformer = transformers[op];
    if (!transformer) {
      error(`Unknown transform: ${op}. Available: ${Object.keys(transformers).join(", ")}`);
    }
    text = transformer(text);
  }
  
  output(text);
}

function cmdTemplate(options: Record<string, unknown>): void {
  const text = readInput(options);
  const dataStr = options.data as string;
  const prefix = String(options.prefix || "{{");
  const suffix = String(options.suffix || "}}");
  
  if (!dataStr) {
    error("Missing --data option");
  }
  
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch {
    error("Invalid JSON in --data");
  }
  
  let result = text;
  for (const [key, value] of Object.entries(data)) {
    const pattern = new RegExp(escapeRegex(prefix) + escapeRegex(key) + escapeRegex(suffix), "g");
    result = result.replace(pattern, String(value ?? ""));
  }
  
  output(result);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cmdCount(options: Record<string, unknown>): void {
  const text = readInput(options);
  
  const result = {
    bytes: Buffer.byteLength(text, CONFIG.defaultEncoding),
    characters: text.length,
    charactersNoSpaces: text.replace(/\s/g, "").length,
    words: text.trim().split(/\s+/).filter(w => w).length,
    lines: text.split("\n").length,
    nonEmptyLines: text.split("\n").filter(l => l.trim()).length,
    paragraphs: text.split(/\n\s*\n/).filter(p => p.trim()).length,
    sentences: text.split(/[.!?]+/).filter(s => s.trim()).length,
  };
  
  output(result);
}

function cmdExtract(options: Record<string, unknown>): void {
  const text = readInput(options);
  const pattern = String(options.pattern || "");
  const unique = options.unique === true;
  const sort = options.sort === true;
  
  let matches: string[];
  
  if (extractPatterns[pattern]) {
    matches = text.match(extractPatterns[pattern]) || [];
  } else {
    // Treat as regex
    try {
      const regex = new RegExp(pattern, "g");
      matches = text.match(regex) || [];
    } catch {
      error(`Invalid pattern: ${pattern}`);
    }
  }
  
  if (unique) {
    matches = [...new Set(matches)];
  }
  
  if (sort) {
    matches.sort();
  }
  
  output({ count: matches.length, matches });
}

function cmdReplace(options: Record<string, unknown>): void {
  const text = readInput(options);
  const find = String(options.find || "");
  const replace = String(options.replace || "");
  const all = options.all !== false; // Default to global
  const flags = all ? "g" : "";
  const caseInsensitive = options.ignoreCase === true ? "i" : "";
  
  if (!find) {
    error("Missing --find option");
  }
  
  try {
    const regex = new RegExp(escapeRegex(find), flags + caseInsensitive);
    const result = text.replace(regex, replace);
    output(result);
  } catch {
    error(`Invalid pattern: ${find}`);
  }
}

function cmdTrim(options: Record<string, unknown>): void {
  const text = readInput(options);
  const mode = String(options.mode || "both");
  
  const lines = text.split("\n");
  const trimmed = lines.map(line => {
    switch (mode) {
      case "left":
        return line.trimStart();
      case "right":
        return line.trimEnd();
      case "both":
      default:
        return line.trim();
    }
  });
  
  output(trimmed.join("\n"));
}

function cmdPad(options: Record<string, unknown>): void {
  const text = readInput(options);
  const width = parseInt(String(options.width || "80"), 10);
  const char = String(options.char || " ");
  const side = String(options.side || "right");
  
  const lines = text.split("\n");
  const padded = lines.map(line => {
    const diff = width - line.length;
    if (diff <= 0) return line;
    
    switch (side) {
      case "left":
        return char.repeat(diff) + line;
      case "right":
        return line + char.repeat(diff);
      case "center":
        const left = Math.floor(diff / 2);
        const right = diff - left;
        return char.repeat(left) + line + char.repeat(right);
      default:
        return line;
    }
  });
  
  output(padded.join("\n"));
}

function cmdWrap(options: Record<string, unknown>): void {
  const text = readInput(options);
  const width = parseInt(String(options.width || "80"), 10);
  const preserveWords = options.preserveWords !== false;
  
  if (!preserveWords) {
    // Simple character wrap
    const result = text.match(new RegExp(`.{1,${width}}`, "g"))?.join("\n") || "";
    output(result);
    return;
  }
  
  // Word-aware wrapping
  const lines = text.split("\n");
  const wrapped = lines.map(line => {
    if (line.length <= width) return line;
    
    const words = line.split(/\s+/);
    const result: string[] = [];
    let current = "";
    
    for (const word of words) {
      if (current.length + word.length + 1 <= width) {
        current = current ? current + " " + word : word;
      } else {
        if (current) result.push(current);
        current = word;
      }
    }
    if (current) result.push(current);
    
    return result.join("\n");
  });
  
  output(wrapped.join("\n"));
}

function cmdAlign(options: Record<string, unknown>): void {
  const text = readInput(options);
  const width = parseInt(String(options.width || "80"), 10);
  const side = String(options.side || "left");
  
  const lines = text.split("\n");
  const aligned = lines.map(line => {
    const diff = width - line.length;
    if (diff <= 0) return line;
    
    switch (side) {
      case "left":
        return line;
      case "right":
        return " ".repeat(diff) + line;
      case "center":
        const left = Math.floor(diff / 2);
        return " ".repeat(left) + line;
      default:
        return line;
    }
  });
  
  output(aligned.join("\n"));
}

function cmdSort(options: Record<string, unknown>): void {
  const text = readInput(options);
  const reverse = options.reverse === true;
  const numeric = options.numeric === true;
  const unique = options.unique === true;
  
  let lines = text.split("\n");
  
  if (numeric) {
    lines.sort((a, b) => {
      const aNum = parseFloat(a);
      const bNum = parseFloat(b);
      return (isNaN(aNum) ? Infinity : aNum) - (isNaN(bNum) ? Infinity : bNum);
    });
  } else {
    lines.sort((a, b) => a.localeCompare(b));
  }
  
  if (reverse) {
    lines.reverse();
  }
  
  if (unique) {
    lines = [...new Set(lines)];
  }
  
  output(lines.join("\n"));
}

function cmdUnique(options: Record<string, unknown>): void {
  const text = readInput(options);
  const caseSensitive = options.caseSensitive !== false;
  const count = options.count === true;
  
  const lines = text.split("\n");
  
  if (count) {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const key = caseSensitive ? line : line.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const result = Array.from(counts.entries())
      .map(([line, cnt]) => ({ line, count: cnt }))
      .sort((a, b) => b.count - a.count);
    output(result);
  } else {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of lines) {
      const key = caseSensitive ? line : line.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(line);
      }
    }
    output(unique.join("\n"));
  }
}

function cmdReverse(options: Record<string, unknown>): void {
  const text = readInput(options);
  const mode = String(options.mode || "chars");
  
  switch (mode) {
    case "chars":
      output(text.split("").reverse().join(""));
      break;
    case "words":
      output(text.split(/\s+/).reverse().join(" "));
      break;
    case "lines":
      output(text.split("\n").reverse().join("\n"));
      break;
    default:
      error(`Unknown mode: ${mode}. Use: chars, words, lines`);
  }
}

// Main CLI
const { positionals, values: options } = parseArgs({
  options: {
    // Input
    text: { type: "string", short: "t" },
    file: { type: "string", short: "f" },
    
    // Case
    to: { type: "string" },
    
    // Transform
    ops: { type: "string" },
    
    // Template
    data: { type: "string", short: "d" },
    prefix: { type: "string" },
    suffix: { type: "string" },
    
    // Extract
    pattern: { type: "string", short: "p" },
    unique: { type: "boolean", short: "u" },
    sort: { type: "boolean", short: "s" },
    
    // Replace
    find: { type: "string" },
    replace: { type: "string", short: "r" },
    all: { type: "boolean" },
    ignoreCase: { type: "boolean", short: "i" },
    
    // Trim/Pad/Align/Wrap
    mode: { type: "string", short: "m" },
    width: { type: "string", short: "w" },
    char: { type: "string", short: "c" },
    side: { type: "string" },
    preserveWords: { type: "boolean" },
    
    // Sort/Unique
    reverse: { type: "boolean" },
    numeric: { type: "boolean", short: "n" },
    caseSensitive: { type: "boolean" },
    count: { type: "boolean" },
    
    // Output
    output: { type: "string", short: "o" },
    
    // Help
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];

if (options.help || !command) {
  console.log(`
Text Tool - Text processing, transformation, and analysis

Commands:
  transform    Apply text transformations
  case         Change text case
  template     Apply template substitutions
  count        Count characters, words, lines
  extract      Extract patterns (emails, URLs, etc.)
  replace      Find and replace text
  trim         Trim whitespace from lines
  pad          Pad text to width
  wrap         Wrap text to column width
  align        Align text (left, right, center)
  sort         Sort lines
  unique       Remove duplicate lines
  reverse      Reverse text or lines

Options:
  -t, --text <text>       Input text
  -f, --file <file>       Input file
  -o, --output <file>     Output file
  -h, --help              Show this help

Case options:
  --to <case>             Target case: upper, lower, title, sentence, camel, pascal, snake, kebab, constant, dot, path, train, header

Transform options:
  --ops <ops>             Comma-separated: trim, ltrim, rtrim, normalize, escape, unescape, urlencode, urldecode, base64encode, base64decode, htmlencode, htmldecode, strip, compact, dedent, indent

Template options:
  -d, --data <json>       Template variables as JSON
  --prefix <str>          Template prefix (default: {{)
  --suffix <str>          Template suffix (default: }})

Extract options:
  -p, --pattern <pat>     Pattern name (email, url, phone, ipv4, ipv6, number, integer, float, hex, uuid, date, time, word, line) or regex
  -u, --unique            Remove duplicates
  -s, --sort              Sort results

Replace options:
  --find <text>           Text to find
  -r, --replace <text>    Replacement text
  --all                   Replace all occurrences (default: true)
  -i, --ignoreCase        Case-insensitive match

Sort options:
  -n, --numeric           Numeric sort
  --reverse               Reverse order
  -u, --unique            Remove duplicates

Examples:
  text case --to upper -t "hello world"
  text transform --ops trim,base64encode -f input.txt
  text extract --pattern email -f data.txt
  text count -f document.txt
  text wrap --width 80 -f input.txt
  text sort --reverse -f lines.txt
  text unique --count -f data.txt
`);
  process.exit(0);
}

// Execute command
switch (command) {
  case "case":
    cmdCase(options);
    break;
  case "transform":
    cmdTransform(options);
    break;
  case "template":
    cmdTemplate(options);
    break;
  case "count":
    cmdCount(options);
    break;
  case "extract":
    cmdExtract(options);
    break;
  case "replace":
    cmdReplace(options);
    break;
  case "trim":
    cmdTrim(options);
    break;
  case "pad":
    cmdPad(options);
    break;
  case "wrap":
    cmdWrap(options);
    break;
  case "align":
    cmdAlign(options);
    break;
  case "sort":
    cmdSort(options);
    break;
  case "unique":
    cmdUnique(options);
    break;
  case "reverse":
    cmdReverse(options);
    break;
  default:
    error(`Unknown command: ${command}`);
}
