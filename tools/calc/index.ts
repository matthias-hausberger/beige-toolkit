#!/usr/bin/env node
/**
 * Calc Tool - Safe mathematical expression calculator with unit conversions
 *
 * Commands:
 *   eval <expression>   - Evaluate a mathematical expression
 *   convert <value> <from> <to> - Convert between units
 *   units [category]    - List available units
 *   functions           - List available math functions
 */

// Tool types
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export interface Tool {
  name: string;
  description: string;
  execute(command: string, params: Record<string, unknown>, config?: unknown): Promise<ToolResult>;
}

// ============================================================================
// Safe Math Expression Parser
// ============================================================================

interface MathContext {
  [key: string]: number | ((...args: number[]) => number);
}

// Safe math functions
const mathFunctions: MathContext = {
  // Basic
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  trunc: Math.trunc,
  sign: Math.sign,

  // Power/Log
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  pow: Math.pow,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,

  // Trigonometry
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,

  // Constants
  pi: Math.PI,
  e: Math.E,
  phi: 1.618033988749895, // Golden ratio
  tau: Math.PI * 2,

  // Utility
  min: Math.min,
  max: Math.max,
  random: Math.random,

  // Conversion helpers
  degToRad: (deg: number) => (deg * Math.PI) / 180,
  radToDeg: (rad: number) => (rad * 180) / Math.PI,

  // Statistics
  avg: (...args: number[]) => args.reduce((a, b) => a + b, 0) / args.length,
  sum: (...args: number[]) => args.reduce((a, b) => a + b, 0),
};

/**
 * Safely evaluate a mathematical expression
 */
export function evaluateExpression(expr: string, precision: number = 6): number {
  // Validate expression
  const sanitized = expr.trim();

  // Security: Only allow safe characters
  const safePattern = /^[0-9+\-*/().^\s,a-zA-Z]+$/;
  if (!safePattern.test(sanitized)) {
    throw new Error(
      `Expression contains unsafe characters. Only numbers, operators (+-*/^), parentheses, functions, and commas are allowed.`
    );
  }

  // Check for balanced parentheses
  let depth = 0;
  for (const char of sanitized) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth < 0) throw new Error("Unbalanced parentheses");
  }
  if (depth !== 0) throw new Error("Unbalanced parentheses");

  // Replace ^ with ** for exponentiation
  let processed = sanitized.replace(/\^/g, "**");

  // Replace function names with safe versions
  const functionPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  processed = processed.replace(functionPattern, (match, name) => {
    const lowerName = name.toLowerCase();
    if (mathFunctions[lowerName] !== undefined) {
      return `__math.${lowerName}(`;
    }
    throw new Error(`Unknown function: ${name}`);
  });

  // Replace constant names
  for (const [name, value] of Object.entries(mathFunctions)) {
    if (typeof value === "number") {
      const constPattern = new RegExp(`\\b${name}\\b`, "gi");
      processed = processed.replace(constPattern, String(value));
    }
  }

  // Create safe evaluation context
  const __math = Object.fromEntries(
    Object.entries(mathFunctions).filter(([_, v]) => typeof v === "function")
  );

  try {
    // Use Function constructor for sandboxed evaluation
    const fn = new Function("__math", `"use strict"; return (${processed})`);
    const result = fn(__math);

    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new Error("Expression did not evaluate to a valid number");
    }

    // Apply precision
    return Number(result.toFixed(precision));
  } catch (err) {
    throw new Error(
      `Failed to evaluate expression: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ============================================================================
// Unit Conversions
// ============================================================================

type UnitCategory = "length" | "weight" | "temperature" | "volume" | "time" | "data";

interface UnitDef {
  name: string;
  category: UnitCategory;
  toBase: (v: number) => number;
  fromBase: (v: number) => number;
  aliases: string[];
}

const units: UnitDef[] = [
  // Length (base: meters)
  {
    name: "meter",
    category: "length",
    toBase: (v) => v,
    fromBase: (v) => v,
    aliases: ["m", "meter", "meters", "metre", "metres"],
  },
  {
    name: "kilometer",
    category: "length",
    toBase: (v) => v * 1000,
    fromBase: (v) => v / 1000,
    aliases: ["km", "kilometer", "kilometers", "kilometre", "kilometres"],
  },
  {
    name: "centimeter",
    category: "length",
    toBase: (v) => v / 100,
    fromBase: (v) => v * 100,
    aliases: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
  },
  {
    name: "millimeter",
    category: "length",
    toBase: (v) => v / 1000,
    fromBase: (v) => v * 1000,
    aliases: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
  },
  {
    name: "mile",
    category: "length",
    toBase: (v) => v * 1609.344,
    fromBase: (v) => v / 1609.344,
    aliases: ["mi", "mile", "miles"],
  },
  {
    name: "yard",
    category: "length",
    toBase: (v) => v * 0.9144,
    fromBase: (v) => v / 0.9144,
    aliases: ["yd", "yard", "yards"],
  },
  {
    name: "foot",
    category: "length",
    toBase: (v) => v * 0.3048,
    fromBase: (v) => v / 0.3048,
    aliases: ["ft", "foot", "feet"],
  },
  {
    name: "inch",
    category: "length",
    toBase: (v) => v * 0.0254,
    fromBase: (v) => v / 0.0254,
    aliases: ["in", "inch", "inches"],
  },

  // Weight (base: kilograms)
  {
    name: "kilogram",
    category: "weight",
    toBase: (v) => v,
    fromBase: (v) => v,
    aliases: ["kg", "kilogram", "kilograms"],
  },
  {
    name: "gram",
    category: "weight",
    toBase: (v) => v / 1000,
    fromBase: (v) => v * 1000,
    aliases: ["g", "gram", "grams"],
  },
  {
    name: "milligram",
    category: "weight",
    toBase: (v) => v / 1000000,
    fromBase: (v) => v * 1000000,
    aliases: ["mg", "milligram", "milligrams"],
  },
  {
    name: "pound",
    category: "weight",
    toBase: (v) => v * 0.453592,
    fromBase: (v) => v / 0.453592,
    aliases: ["lb", "lbs", "pound", "pounds"],
  },
  {
    name: "ounce",
    category: "weight",
    toBase: (v) => v * 0.0283495,
    fromBase: (v) => v / 0.0283495,
    aliases: ["oz", "ounce", "ounces"],
  },
  {
    name: "ton",
    category: "weight",
    toBase: (v) => v * 1000,
    fromBase: (v) => v / 1000,
    aliases: ["t", "ton", "tons", "tonne", "tonnes", "metric ton"],
  },

  // Temperature (special - needs direct conversion)
  // Base: Celsius
  {
    name: "celsius",
    category: "temperature",
    toBase: (v) => v,
    fromBase: (v) => v,
    aliases: ["c", "celsius", "celcius"],
  },
  {
    name: "fahrenheit",
    category: "temperature",
    toBase: (v) => ((v - 32) * 5) / 9,
    fromBase: (v) => (v * 9) / 5 + 32,
    aliases: ["f", "fahrenheit"],
  },
  {
    name: "kelvin",
    category: "temperature",
    toBase: (v) => v - 273.15,
    fromBase: (v) => v + 273.15,
    aliases: ["k", "kelvin"],
  },

  // Volume (base: liters)
  {
    name: "liter",
    category: "volume",
    toBase: (v) => v,
    fromBase: (v) => v,
    aliases: ["l", "liter", "liters", "litre", "litres"],
  },
  {
    name: "milliliter",
    category: "volume",
    toBase: (v) => v / 1000,
    fromBase: (v) => v * 1000,
    aliases: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  },
  {
    name: "gallon",
    category: "volume",
    toBase: (v) => v * 3.78541,
    fromBase: (v) => v / 3.78541,
    aliases: ["gal", "gallon", "gallons", "us gallon"],
  },
  {
    name: "quart",
    category: "volume",
    toBase: (v) => v * 0.946353,
    fromBase: (v) => v / 0.946353,
    aliases: ["qt", "quart", "quarts"],
  },
  {
    name: "pint",
    category: "volume",
    toBase: (v) => v * 0.473176,
    fromBase: (v) => v / 0.473176,
    aliases: ["pt", "pint", "pints"],
  },
  {
    name: "cup",
    category: "volume",
    toBase: (v) => v * 0.236588,
    fromBase: (v) => v / 0.236588,
    aliases: ["cup", "cups"],
  },
  {
    name: "fluid ounce",
    category: "volume",
    toBase: (v) => v * 0.0295735,
    fromBase: (v) => v / 0.0295735,
    aliases: ["fl oz", "floz", "fluid ounce", "fluid ounces"],
  },

  // Time (base: seconds)
  {
    name: "second",
    category: "time",
    toBase: (v) => v,
    fromBase: (v) => v,
    aliases: ["s", "sec", "second", "seconds"],
  },
  {
    name: "minute",
    category: "time",
    toBase: (v) => v * 60,
    fromBase: (v) => v / 60,
    aliases: ["min", "minute", "minutes"],
  },
  {
    name: "hour",
    category: "time",
    toBase: (v) => v * 3600,
    fromBase: (v) => v / 3600,
    aliases: ["h", "hr", "hour", "hours"],
  },
  {
    name: "day",
    category: "time",
    toBase: (v) => v * 86400,
    fromBase: (v) => v / 86400,
    aliases: ["d", "day", "days"],
  },
  {
    name: "week",
    category: "time",
    toBase: (v) => v * 604800,
    fromBase: (v) => v / 604800,
    aliases: ["w", "week", "weeks"],
  },
  {
    name: "year",
    category: "time",
    toBase: (v) => v * 31536000,
    fromBase: (v) => v / 31536000,
    aliases: ["y", "yr", "year", "years"],
  },
  {
    name: "millisecond",
    category: "time",
    toBase: (v) => v / 1000,
    fromBase: (v) => v * 1000,
    aliases: ["ms", "millisecond", "milliseconds"],
  },

  // Data (base: bytes)
  {
    name: "byte",
    category: "data",
    toBase: (v) => v,
    fromBase: (v) => v,
    aliases: ["b", "byte", "bytes"],
  },
  {
    name: "kilobyte",
    category: "data",
    toBase: (v) => v * 1024,
    fromBase: (v) => v / 1024,
    aliases: ["kb", "kilobyte", "kilobytes"],
  },
  {
    name: "megabyte",
    category: "data",
    toBase: (v) => v * 1024 * 1024,
    fromBase: (v) => v / (1024 * 1024),
    aliases: ["mb", "megabyte", "megabytes"],
  },
  {
    name: "gigabyte",
    category: "data",
    toBase: (v) => v * 1024 * 1024 * 1024,
    fromBase: (v) => v / (1024 * 1024 * 1024),
    aliases: ["gb", "gigabyte", "gigabytes"],
  },
  {
    name: "terabyte",
    category: "data",
    toBase: (v) => v * 1024 * 1024 * 1024 * 1024,
    fromBase: (v) => v / (1024 * 1024 * 1024 * 1024),
    aliases: ["tb", "terabyte", "terabytes"],
  },
  {
    name: "bit",
    category: "data",
    toBase: (v) => v / 8,
    fromBase: (v) => v * 8,
    aliases: ["bit", "bits"],
  },
];

// Build lookup map
const unitMap = new Map<string, UnitDef>();
for (const unit of units) {
  for (const alias of unit.aliases) {
    unitMap.set(alias.toLowerCase(), unit);
  }
}

/**
 * Convert between units
 */
export function convertUnit(value: number, from: string, to: string): number {
  const fromUnit = unitMap.get(from.toLowerCase());
  const toUnit = unitMap.get(to.toLowerCase());

  if (!fromUnit) {
    throw new Error(
      `Unknown unit: '${from}'. Use 'calc units' to see available units.`
    );
  }
  if (!toUnit) {
    throw new Error(
      `Unknown unit: '${to}'. Use 'calc units' to see available units.`
    );
  }

  if (fromUnit.category !== toUnit.category) {
    throw new Error(
      `Cannot convert from ${fromUnit.category} to ${toUnit.category}. Units must be in the same category.`
    );
  }

  const baseValue = fromUnit.toBase(value);
  return toUnit.fromBase(baseValue);
}

/**
 * Get available units by category
 */
export function getUnitsByCategory(category?: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const unit of units) {
    if (category && unit.category !== category.toLowerCase()) {
      continue;
    }
    if (!result[unit.category]) {
      result[unit.category] = [];
    }
    if (!result[unit.category].includes(unit.name)) {
      result[unit.category].push(unit.name);
    }
  }

  return result;
}

// ============================================================================
// Tool Implementation
// ============================================================================

interface CalcConfig {
  maxExpressionLength?: number;
  defaultPrecision?: number;
  allowVariables?: boolean;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  if (Math.abs(n) < 0.000001 || Math.abs(n) > 999999999) {
    return n.toExponential(6);
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

async function handleEval(
  expression: string,
  precision?: number,
  config?: CalcConfig
): Promise<ToolResult> {
  const maxLen = config?.maxExpressionLength || 1000;
  const prec = precision ?? config?.defaultPrecision ?? 6;

  if (expression.length > maxLen) {
    return {
      success: false,
      error: `Expression too long (max ${maxLen} characters)`,
    };
  }

  try {
    const result = evaluateExpression(expression, prec);
    return {
      success: true,
      data: {
        expression,
        result,
        formatted: formatNumber(result),
      },
      message: `${expression} = ${formatNumber(result)}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleConvert(
  value: number,
  from: string,
  to: string
): Promise<ToolResult> {
  try {
    const result = convertUnit(value, from, to);
    return {
      success: true,
      data: {
        original: { value, unit: from },
        converted: { value: result, unit: to },
      },
      message: `${formatNumber(value)} ${from} = ${formatNumber(result)} ${to}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleUnits(category?: string): Promise<ToolResult> {
  const unitsByCategory = getUnitsByCategory(category);

  if (category && Object.keys(unitsByCategory).length === 0) {
    return {
      success: false,
      error: `Unknown category: '${category}'. Available: length, weight, temperature, volume, time, data`,
    };
  }

  const lines: string[] = [];
  for (const [cat, unitNames] of Object.entries(unitsByCategory)) {
    lines.push(`${cat.toUpperCase()}: ${unitNames.join(", ")}`);
  }

  return {
    success: true,
    data: unitsByCategory,
    message: lines.join("\n"),
  };
}

async function handleFunctions(): Promise<ToolResult> {
  const functions = Object.entries(mathFunctions)
    .filter(([_, v]) => typeof v === "function")
    .map(([name]) => name);

  const constants = Object.entries(mathFunctions)
    .filter(([_, v]) => typeof v === "number")
    .map(([name, value]) => `${name} = ${value}`);

  return {
    success: true,
    data: {
      functions: functions.sort(),
      constants: constants.sort(),
    },
    message:
      `FUNCTIONS: ${functions.sort().join(", ")}\n` +
      `CONSTANTS: ${constants.sort().join(", ")}`,
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = Deno.args;
  const command = args[0]?.toLowerCase();

  if (!command || command === "help" || command === "--help") {
    console.log(`
Calc Tool - Safe mathematical expression calculator

USAGE:
  calc eval <expression>          Evaluate a mathematical expression
  calc convert <value> <from> <to> Convert between units
  calc units [category]            List available units
  calc functions                   List available math functions

EXAMPLES:
  calc eval "2 + 2 * 3"
  calc eval "sqrt(16) + pi"
  calc eval "sin(pi/4)"
  calc eval "avg(1, 2, 3, 4, 5)"
  calc convert 100 km miles
  calc convert 72 fahrenheit celsius
  calc units length
  calc functions
`);
    Deno.exit(0);
  }

  let result: ToolResult;

  switch (command) {
    case "eval":
    case "evaluate":
    case "calc":
    case "calculate": {
      const expression = args.slice(1).join(" ");
      if (!expression) {
        console.error("Error: Expression required");
        Deno.exit(1);
      }
      result = await handleEval(expression);
      break;
    }

    case "convert":
    case "conv": {
      const value = parseFloat(args[1]);
      const from = args[2];
      const to = args[3];

      if (isNaN(value) || !from || !to) {
        console.error("Usage: calc convert <value> <from> <to>");
        console.error("Example: calc convert 100 km miles");
        Deno.exit(1);
      }
      result = await handleConvert(value, from, to);
      break;
    }

    case "units":
    case "unit": {
      const category = args[1];
      result = await handleUnits(category);
      break;
    }

    case "functions":
    case "funcs":
    case "help": {
      result = await handleFunctions();
      break;
    }

    default:
      // Treat as expression
      result = await handleEval(args.join(" "));
  }

  if (result.success) {
    console.log(result.message);
    if (result.data) {
      console.log("\nData:", JSON.stringify(result.data, null, 2));
    }
  } else {
    console.error("Error:", result.error);
    Deno.exit(1);
  }
}

// Export for tool runner
export const tool: Tool = {
  name: "calc",
  description: "Safe mathematical expression calculator with unit conversions",
  async execute(command: string, params: Record<string, unknown>, config?: CalcConfig): Promise<ToolResult> {
    switch (command.toLowerCase()) {
      case "eval":
      case "evaluate":
        return handleEval(
          params.expression as string,
          params.precision as number | undefined,
          config
        );

      case "convert":
      case "conv":
        return handleConvert(
          params.value as number,
          params.from as string,
          params.to as string
        );

      case "units":
      case "unit":
        return handleUnits(params.category as string | undefined);

      case "functions":
      case "funcs":
        return handleFunctions();

      default:
        // Treat command as expression
        return handleEval(command, undefined, config);
    }
  },
};

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
