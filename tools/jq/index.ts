#!/usr/bin/env node
/**
 * JQ Tool - JSON and YAML manipulation
 *
 * Provides powerful JSON/YAML querying and transformation using jq-like syntax
 * without requiring jq to be installed.
 *
 * @module tools/jq
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

interface JqConfig {
  /** Maximum input file size in bytes (default: 10MB) */
  maxFileSize?: number;
  /** Maximum output depth (default: 10) */
  maxDepth?: number;
  /** Allowed paths for file operations (default: all) */
  allowedPaths?: string[];
  /** Denied paths for file operations */
  deniedPaths?: string[];
  /** Allow writing files */
  allowWrite?: boolean;
}

interface JqOptions {
  /** Input file path */
  file?: string;
  /** Output file path */
  output?: string;
  /** Input format */
  inputFormat?: "json" | "yaml";
  /** Output format */
  outputFormat?: "json" | "yaml" | "compact";
  /** Raw string output (no quotes) */
  raw?: boolean;
  /** Pretty print JSON */
  pretty?: boolean;
  /** Tab width for YAML output */
  tabWidth?: number;
  /** Sort object keys */
  sortKeys?: boolean;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject { [key: string]: JsonValue }
type JsonArray = JsonValue[];

// ============================================================================
// YAML Parser (simple implementation)
// ============================================================================

class SimpleYamlParser {
  private lines: string[];
  private pos: number = 0;

  constructor(content: string) {
    this.lines = content.split('\n');
  }

  parse(): JsonValue {
    return this.parseValue(0);
  }

  private parseValue(indent: number): JsonValue {
    this.skipEmptyLines();
    if (this.pos >= this.lines.length) return null;

    const line = this.lines[this.pos];
    const currentIndent = this.getIndent(line);

    // Check for array item
    if (line.trimStart().startsWith('- ')) {
      return this.parseArray(currentIndent);
    }

    // Check for object
    if (line.includes(':')) {
      return this.parseObject(currentIndent);
    }

    // Scalar value
    return this.parseScalar(line.trim());
  }

  private parseObject(baseIndent: number): JsonObject {
    const obj: JsonObject = {};

    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.trim() === '') {
        this.pos++;
        continue;
      }

      const currentIndent = this.getIndent(line);
      if (currentIndent < baseIndent) break;
      if (currentIndent > baseIndent) {
        this.pos++;
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) break;

      const key = line.substring(0, colonIndex).trim();
      let value: JsonValue;

      const afterColon = line.substring(colonIndex + 1).trim();
      if (afterColon === '' || afterColon === '|' || afterColon === '>') {
        // Value on next line(s) or multiline
        this.pos++;
        value = this.parseValue(currentIndent + 2);
      } else {
        value = this.parseScalar(afterColon);
        this.pos++;
      }

      obj[key] = value;
    }

    return obj;
  }

  private parseArray(baseIndent: number): JsonArray {
    const arr: JsonArray = [];

    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.trim() === '') {
        this.pos++;
        continue;
      }

      const currentIndent = this.getIndent(line);
      if (currentIndent < baseIndent) break;

      const trimmed = line.trimStart();
      if (trimmed.startsWith('- ')) {
        const itemValue = trimmed.substring(2).trim();
        this.pos++;

        if (itemValue === '' || itemValue === '|' || itemValue === '>') {
          // Array item value on next line
          arr.push(this.parseValue(currentIndent + 2));
        } else if (itemValue.includes(':')) {
          // Array item is an object
          this.pos--;
          arr.push(this.parseObject(currentIndent + 2));
          this.pos++;
        } else {
          arr.push(this.parseScalar(itemValue));
        }
      } else {
        break;
      }
    }

    return arr;
  }

  private parseScalar(value: string): JsonValue {
    const trimmed = value.trim();

    if (trimmed === 'null' || trimmed === '~') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
    }

    // Quoted string
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  private getIndent(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  private skipEmptyLines(): void {
    while (this.pos < this.lines.length && this.lines[this.pos].trim() === '') {
      this.pos++;
    }
  }
}

// ============================================================================
// YAML Stringifier
// ============================================================================

function toYaml(value: JsonValue, indent: number = 0, tabWidth: number = 2): string {
  const spaces = ' '.repeat(indent);

  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // Quote strings that look like special values or contain special chars
    if (['true', 'false', 'null', '~'].includes(value) ||
        /[:#\[\]{}|>]/.test(value) ||
        value.startsWith(' ') ||
        value.startsWith('-')) {
      return JSON.stringify(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map(item => {
      const itemYaml = toYaml(item, indent + tabWidth, tabWidth);
      if (typeof item === 'object' && item !== null) {
        return `${spaces}- ${itemYaml.trimStart()}`;
      }
      return `${spaces}- ${itemYaml}`;
    }).join('\n');
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return entries.map(([key, val]) => {
      if (typeof val === 'object' && val !== null) {
        if (Object.keys(val).length === 0 || (Array.isArray(val) && val.length === 0)) {
          return `${spaces}${key}: ${toYaml(val, indent + tabWidth, tabWidth)}`;
        }
        return `${spaces}${key}:\n${toYaml(val, indent + tabWidth, tabWidth)}`;
      }
      return `${spaces}${key}: ${toYaml(val, indent + tabWidth, tabWidth)}`;
    }).join('\n');
  }

  return String(value);
}

// ============================================================================
// JQ-like Query Engine
// ============================================================================

class JqQuery {
  private tokens: Token[];

  constructor(query: string) {
    this.tokens = this.tokenize(query);
  }

  execute(input: JsonValue): JsonValue {
    let result: JsonValue = input;

    for (const token of this.tokens) {
      result = this.applyToken(token, result);
      if (result === undefined) return null;
    }

    return result;
  }

  private tokenize(query: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;

    while (pos < query.length) {
      // Skip whitespace
      while (pos < query.length && /\s/.test(query[pos])) pos++;
      if (pos >= query.length) break;

      // Pipe
      if (query[pos] === '|') {
        pos++;
        continue;
      }

      // Dot accessor
      if (query[pos] === '.') {
        pos++;
        if (pos < query.length && query[pos] === '.') {
          // Recursive descent ..
          tokens.push({ type: 'recursive' });
          pos++;
          continue;
        }
        // Property access
        let prop = '';
        while (pos < query.length && /[\w\-]/.test(query[pos])) {
          prop += query[pos++];
        }
        if (prop) {
          tokens.push({ type: 'property', value: prop });
        }
        continue;
      }

      // Bracket accessor
      if (query[pos] === '[') {
        pos++;
        // Array slice [start:end]
        if (query[pos] === ':') {
          pos++;
          let end = '';
          while (pos < query.length && query[pos] !== ']') {
            end += query[pos++];
          }
          pos++; // skip ]
          tokens.push({ type: 'slice', start: undefined, end: end ? parseInt(end) : undefined });
          continue;
        }

        // Collect content until ]
        let content = '';
        let depth = 1;
        while (pos < query.length && depth > 0) {
          if (query[pos] === '[') depth++;
          if (query[pos] === ']') depth--;
          if (depth > 0) content += query[pos];
          pos++;
        }

        // Check if it's a number (array index) or string (property)
        if (/^\d+$/.test(content.trim())) {
          tokens.push({ type: 'index', value: parseInt(content.trim()) });
        } else if (/^\d+:\d*$/.test(content.trim()) || /^:\d+$/.test(content.trim())) {
          // Slice notation
          const parts = content.trim().split(':');
          tokens.push({
            type: 'slice',
            start: parts[0] ? parseInt(parts[0]) : undefined,
            end: parts[1] ? parseInt(parts[1]) : undefined
          });
        } else {
          // Property name (remove quotes if present)
          const prop = content.trim().replace(/^["']|["']$/g, '');
          tokens.push({ type: 'property', value: prop });
        }
        continue;
      }

      // Built-in functions
      if (query.slice(pos).match(/^(keys|values|length|type|sort|reverse|unique|flatten|first|last|map|select|has|contains|to_entries|from_entries|add|join)\b/)) {
        const match = query.slice(pos).match(/^(keys|values|length|type|sort|reverse|unique|flatten|first|last|has|contains|to_entries|from_entries|add|join)/);
        if (match) {
          const fn = match[1];
          pos += fn.length;

          // Check for arguments in parentheses
          let args: string | undefined;
          if (pos < query.length && query[pos] === '(') {
            pos++;
            let depth = 1;
            args = '';
            while (pos < query.length && depth > 0) {
              if (query[pos] === '(') depth++;
              if (query[pos] === ')') depth--;
              if (depth > 0) args += query[pos];
              pos++;
            }
          }

          tokens.push({ type: 'function', value: fn, args });
          continue;
        }
      }

      // Identity (just .)
      if (query[pos] === '.' && pos === query.length - 1) {
        tokens.push({ type: 'identity' });
        pos++;
        continue;
      }

      // Unknown token - skip
      pos++;
    }

    return tokens;
  }

  private applyToken(token: Token, value: JsonValue): JsonValue {
    switch (token.type) {
      case 'identity':
        return value;

      case 'property':
        if (value === null || value === undefined) return null;
        if (typeof value === 'object' && !Array.isArray(value)) {
          return (value as JsonObject)[token.value!];
        }
        return null;

      case 'index':
        if (Array.isArray(value)) {
          const idx = token.value! < 0 ? value.length + token.value! : token.value!;
          return value[idx];
        }
        return null;

      case 'slice':
        if (Array.isArray(value)) {
          return value.slice(token.start ?? 0, token.end);
        }
        if (typeof value === 'string') {
          return value.slice(token.start ?? 0, token.end);
        }
        return null;

      case 'recursive':
        // Recursive descent - collect all matching values
        return this.recursiveDescent(value);

      case 'function':
        return this.applyFunction(token.value!, token.args, value);

      default:
        return value;
    }
  }

  private recursiveDescent(value: JsonValue): JsonArray {
    const results: JsonArray = [];

    const traverse = (v: JsonValue) => {
      if (v === null || v === undefined) return;
      results.push(v);

      if (Array.isArray(v)) {
        v.forEach(traverse);
      } else if (typeof v === 'object') {
        Object.values(v).forEach(traverse);
      }
    };

    traverse(value);
    return results;
  }

  private applyFunction(fn: string, args: string | undefined, value: JsonValue): JsonValue {
    switch (fn) {
      case 'keys':
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return Object.keys(value);
        }
        return [];

      case 'values':
        if (typeof value === 'object' && value !== null) {
          return Array.isArray(value) ? value : Object.values(value);
        }
        return [];

      case 'length':
        if (typeof value === 'string') return value.length;
        if (Array.isArray(value)) return value.length;
        if (typeof value === 'object' && value !== null) return Object.keys(value).length;
        return 0;

      case 'type':
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;

      case 'sort':
        if (Array.isArray(value)) {
          return [...value].sort((a, b) => {
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
          });
        }
        return value;

      case 'reverse':
        if (Array.isArray(value)) return [...value].reverse();
        if (typeof value === 'string') return value.split('').reverse().join('');
        return value;

      case 'unique':
        if (Array.isArray(value)) {
          const seen = new Set<string>();
          return value.filter(item => {
            const key = JSON.stringify(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        return value;

      case 'flatten':
        if (Array.isArray(value)) {
          const flat: JsonArray = [];
          const flattenArr = (arr: JsonArray) => {
            arr.forEach(item => {
              if (Array.isArray(item)) flattenArr(item);
              else flat.push(item);
            });
          };
          flattenArr(value);
          return flat;
        }
        return value;

      case 'first':
        if (Array.isArray(value) && value.length > 0) return value[0];
        return null;

      case 'last':
        if (Array.isArray(value) && value.length > 0) return value[value.length - 1];
        return null;

      case 'has':
        if (args && typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return args.replace(/^["']|["']$/g, '') in value;
        }
        return false;

      case 'contains':
        if (args && typeof value === 'string') {
          return value.includes(args.replace(/^["']|["']$/g, ''));
        }
        if (args && Array.isArray(value)) {
          const search = JSON.parse(args);
          return value.some(item => JSON.stringify(item) === JSON.stringify(search));
        }
        return false;

      case 'to_entries':
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return Object.entries(value).map(([k, v]) => ({ key: k, value: v }));
        }
        return [];

      case 'from_entries':
        if (Array.isArray(value)) {
          const obj: JsonObject = {};
          value.forEach(item => {
            if (typeof item === 'object' && item !== null && 'key' in item) {
              obj[item.key as string] = (item as JsonObject).value ?? null;
            }
          });
          return obj;
        }
        return {};

      case 'add':
        if (Array.isArray(value)) {
          if (value.length === 0) return null;
          if (typeof value[0] === 'number') {
            return value.reduce((sum: number, n) => sum + (typeof n === 'number' ? n : 0), 0);
          }
          if (typeof value[0] === 'string') {
            return value.join('');
          }
          if (Array.isArray(value[0])) {
            return value.flat();
          }
        }
        return null;

      case 'join':
        const separator = args?.replace(/^["']|["']$/g, '') ?? '';
        if (Array.isArray(value)) {
          return value.map(String).join(separator);
        }
        return '';

      case 'map':
        // map(.property) - apply query to each element
        if (args && Array.isArray(value)) {
          const subQuery = new JqQuery(args);
          return value.map(item => subQuery.execute(item));
        }
        return value;

      case 'select':
        // select(.property == value) - filter array
        if (args && Array.isArray(value)) {
          return value.filter(item => {
            // Simple equality check
            const match = args.match(/\.(\w+)\s*==\s*(.+)/);
            if (match) {
              const prop = match[1];
              const target = match[2].trim().replace(/^["']|["']$/g, '');
              const itemValue = (item as JsonObject)?.[prop];
              return String(itemValue) === target;
            }
            return true;
          });
        }
        return value;

      default:
        return value;
    }
  }
}

interface Token {
  type: 'identity' | 'property' | 'index' | 'slice' | 'recursive' | 'function';
  value?: string | number;
  start?: number;
  end?: number;
  args?: string;
}

// ============================================================================
// Main Implementation
// ============================================================================

async function jq(args: string[], config: JqConfig): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      'input-format': { type: 'string' },
      'output-format': { type: 'string' },
      raw: { type: 'boolean', short: 'r' },
      pretty: { type: 'boolean', short: 'p' },
      'tab-width': { type: 'string' },
      'sort-keys': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    return;
  }

  const options: JqOptions = {
    file: values.file,
    output: values.output,
    inputFormat: (values['input-format'] as JqOptions['inputFormat']) || 'json',
    outputFormat: (values['output-format'] as JqOptions['outputFormat']) || 'json',
    raw: values.raw,
    pretty: values.pretty ?? true,
    tabWidth: parseInt(values['tab-width'] || '2', 10),
    sortKeys: values['sort-keys'],
  };

  // Get query (first positional)
  const query = values._[0] as string || '.';

  // Get input
  let input: JsonValue;

  if (options.file) {
    // Read from file
    validatePath(options.file, config);

    if (!fs.existsSync(options.file)) {
      console.error(`Error: File not found: ${options.file}`);
      process.exit(1);
    }

    const stats = fs.statSync(options.file);
    const maxSize = config.maxFileSize || 10 * 1024 * 1024; // 10MB default
    if (stats.size > maxSize) {
      console.error(`Error: File too large (${stats.size} bytes, max: ${maxSize})`);
      process.exit(1);
    }

    const content = fs.readFileSync(options.file, 'utf-8');

    try {
      if (options.inputFormat === 'yaml') {
        const parser = new SimpleYamlParser(content);
        input = parser.parse();
      } else {
        input = JSON.parse(content);
      }
    } catch (e) {
      console.error(`Error: Failed to parse ${options.inputFormat}: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    // Read from stdin
    const content = await readStdin();
    if (!content) {
      console.error('Error: No input provided. Use -f to specify a file or pipe input.');
      process.exit(1);
    }

    try {
      if (options.inputFormat === 'yaml') {
        const parser = new SimpleYamlParser(content);
        input = parser.parse();
      } else {
        input = JSON.parse(content);
      }
    } catch (e) {
      console.error(`Error: Failed to parse ${options.inputFormat}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Execute query
  const jqQuery = new JqQuery(query);
  const result = jqQuery.execute(input);

  // Format output
  let output: string;

  if (options.outputFormat === 'yaml') {
    output = toYaml(result, 0, options.tabWidth);
  } else if (options.outputFormat === 'compact') {
    output = JSON.stringify(result);
  } else if (options.raw && typeof result === 'string') {
    output = result;
  } else if (options.pretty !== false) {
    output = JSON.stringify(result, null, options.tabWidth);
  } else {
    output = JSON.stringify(result);
  }

  // Sort keys if requested
  if (options.sortKeys && typeof result === 'object' && result !== null) {
    const sorted = sortKeys(result);
    if (options.outputFormat === 'yaml') {
      output = toYaml(sorted, 0, options.tabWidth);
    } else {
      output = JSON.stringify(sorted, null, options.tabWidth);
    }
  }

  // Write output
  if (options.output) {
    validatePath(options.output, config);
    fs.writeFileSync(options.output, output + '\n');
    console.log(`Output written to ${options.output}`);
  } else {
    console.log(output);
  }
}

function sortKeys(obj: JsonValue): JsonValue {
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  if (typeof obj === 'object' && obj !== null) {
    const sorted: JsonObject = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = sortKeys(obj[key]);
    });
    return sorted;
  }
  return obj;
}

function validatePath(filePath: string, config: JqConfig): void {
  const resolved = path.resolve(filePath);

  if (config.deniedPaths?.some(p => resolved.startsWith(path.resolve(p)))) {
    console.error(`Error: Access denied: ${filePath}`);
    process.exit(1);
  }

  if (config.allowedPaths && config.allowedPaths.length > 0) {
    if (!config.allowedPaths.some(p => resolved.startsWith(path.resolve(p)))) {
      console.error(`Error: Path not allowed: ${filePath}`);
      process.exit(1);
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));

    // Timeout if no input
    setTimeout(() => {
      if (data === '') resolve('');
    }, 100);
  });
}

function showHelp(): void {
  console.log(`
JQ Tool - JSON and YAML manipulation

USAGE:
  jq <query> [options]
  jq <query> -f <file> [options]

QUERY SYNTAX:
  .                    Identity (pass through)
  .foo                 Get property 'foo'
  .foo.bar             Nested property access
  .[0]                 Array index
  .[1:3]               Array slice (elements 1-2)
  .[]                  Iterate array (returns all elements)
  ..                   Recursive descent

BUILT-IN FUNCTIONS:
  keys                 Get object keys as array
  values               Get object values as array
  length               Get length of string/array/object
  type                 Get type: "null", "boolean", "number", "string", "array", "object"
  sort                 Sort array
  reverse              Reverse array or string
  unique               Remove duplicates from array
  flatten              Flatten nested arrays
  first                Get first element of array
  last                 Get last element of array
  has("key")           Check if object has key
  contains("str")      Check if string/array contains value
  to_entries           Convert object to [{key, value}, ...]
  from_entries         Convert [{key, value}, ...] to object
  add                  Sum numbers / concatenate strings / merge arrays
  join("sep")          Join array elements with separator
  map(.foo)            Map query over array elements
  select(.x == "y")    Filter array by condition

OPTIONS:
  -f, --file <path>         Input file (JSON or YAML)
  -o, --output <path>       Output file
  --input-format <fmt>      Input format: json (default), yaml
  --output-format <fmt>     Output format: json (default), yaml, compact
  -r, --raw                 Raw string output (no quotes)
  -p, --pretty              Pretty print JSON (default: true)
  --tab-width <n>           Tab width for output (default: 2)
  --sort-keys               Sort object keys alphabetically
  -h, --help                Show this help

EXAMPLES:
  jq '.name' data.json                    Get 'name' property
  jq '.users[0].name' data.json           Get first user's name
  jq '.items | length' data.json          Get number of items
  jq '.users | map(.name)' data.json      Get all user names
  jq '.items | sort | reverse' data.json  Sort and reverse items
  jq '.' data.yaml --input-format yaml    Convert YAML to JSON
  jq '.' data.json --output-format yaml   Convert JSON to YAML
  jq '.users[] | select(.active == true)' data.json   Filter active users
`);
}

// ============================================================================
// Exports
// ============================================================================

export {
  jq,
  JqQuery,
  SimpleYamlParser,
  toYaml,
  type JqConfig,
  type JqOptions,
  type JsonValue,
  type JsonObject,
  type JsonArray,
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const config: JqConfig = {
    maxFileSize: process.env.JQ_MAX_FILE_SIZE
      ? parseInt(process.env.JQ_MAX_FILE_SIZE, 10)
      : 10 * 1024 * 1024,
    allowWrite: process.env.JQ_ALLOW_WRITE !== 'false',
  };

  jq(process.argv.slice(2), config).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
