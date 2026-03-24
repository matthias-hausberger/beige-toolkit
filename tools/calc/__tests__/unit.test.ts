#!/usr/bin/env deno run
/**
 * Unit tests for Calc tool
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import { tool, evaluateExpression, convertUnit, getUnitsByCategory } from "../index.ts";

// Local ToolResult type
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

// ============================================================================
// Expression Evaluation Tests
// ============================================================================

Deno.test("eval - basic arithmetic", async () => {
  const result = await tool.execute("eval", { expression: "2 + 2" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 4);
});

Deno.test("eval - operator precedence", async () => {
  const result = await tool.execute("eval", { expression: "2 + 2 * 3" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 8);
});

Deno.test("eval - parentheses", async () => {
  const result = await tool.execute("eval", { expression: "(2 + 2) * 3" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 12);
});

Deno.test("eval - exponentiation", async () => {
  const result1 = await tool.execute("eval", { expression: "2^10" });
  assertEquals(result1.success, true);
  assertEquals(result1.data?.result, 1024);

  const result2 = await tool.execute("eval", { expression: "2**10" });
  assertEquals(result2.success, true);
  assertEquals(result2.data?.result, 1024);
});

Deno.test("eval - negative numbers", async () => {
  const result = await tool.execute("eval", { expression: "-5 + 10" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 5);
});

Deno.test("eval - decimal numbers", async () => {
  const result = await tool.execute("eval", { expression: "0.5 + 0.5" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 1);
});

Deno.test("eval - division", async () => {
  const result = await tool.execute("eval", { expression: "10 / 4" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 2.5);
});

// ============================================================================
// Function Tests
// ============================================================================

Deno.test("eval - sqrt function", async () => {
  const result = await tool.execute("eval", { expression: "sqrt(144)" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 12);
});

Deno.test("eval - pow function", async () => {
  const result = await tool.execute("eval", { expression: "pow(2, 8)" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 256);
});

Deno.test("eval - trigonometry", async () => {
  const result = await tool.execute("eval", { expression: "sin(pi/2)" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 1);
});

Deno.test("eval - log functions", async () => {
  const result = await tool.execute("eval", { expression: "log(e)" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 1);
});

Deno.test("eval - floor and ceil", async () => {
  const floorResult = await tool.execute("eval", { expression: "floor(3.7)" });
  assertEquals(floorResult.success, true);
  assertEquals(floorResult.data?.result, 3);

  const ceilResult = await tool.execute("eval", { expression: "ceil(3.2)" });
  assertEquals(ceilResult.success, true);
  assertEquals(ceilResult.data?.result, 4);
});

Deno.test("eval - min and max", async () => {
  const minResult = await tool.execute("eval", { expression: "min(5, 2, 8, 1)" });
  assertEquals(minResult.success, true);
  assertEquals(minResult.data?.result, 1);

  const maxResult = await tool.execute("eval", { expression: "max(5, 2, 8, 1)" });
  assertEquals(maxResult.success, true);
  assertEquals(maxResult.data?.result, 8);
});

Deno.test("eval - avg and sum", async () => {
  const avgResult = await tool.execute("eval", { expression: "avg(10, 20, 30)" });
  assertEquals(avgResult.success, true);
  assertEquals(avgResult.data?.result, 20);

  const sumResult = await tool.execute("eval", { expression: "sum(1, 2, 3, 4, 5)" });
  assertEquals(sumResult.success, true);
  assertEquals(sumResult.data?.result, 15);
});

Deno.test("eval - nested functions", async () => {
  const result = await tool.execute("eval", { expression: "sqrt(abs(-16))" });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 4);
});

// ============================================================================
// Constants Tests
// ============================================================================

Deno.test("eval - pi constant", async () => {
  const result = await tool.execute("eval", { expression: "pi" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.result - 3.141592) < 0.001);
});

Deno.test("eval - e constant", async () => {
  const result = await tool.execute("eval", { expression: "e" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.result - 2.718281) < 0.001);
});

Deno.test("eval - tau constant", async () => {
  const result = await tool.execute("eval", { expression: "tau" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.result - 6.283185) < 0.001);
});

// ============================================================================
// Error Handling Tests
// ============================================================================

Deno.test("eval - unknown function error", async () => {
  const result = await tool.execute("eval", { expression: "unknownFunc(5)" });
  assertEquals(result.success, false);
  assert(result.error?.includes("Unknown function"));
});

Deno.test("eval - unbalanced parentheses error", async () => {
  const result = await tool.execute("eval", { expression: "(2 + 3" });
  assertEquals(result.success, false);
  assert(result.error?.includes("Unbalanced"));
});

Deno.test("eval - invalid characters error", async () => {
  const result = await tool.execute("eval", { expression: "2 + $invalid" });
  assertEquals(result.success, false);
  assert(result.error?.includes("unsafe characters"));
});

Deno.test("eval - division by zero", async () => {
  const result = await tool.execute("eval", { expression: "1 / 0" });
  assertEquals(result.success, false);
});

Deno.test("eval - expression too long", async () => {
  const longExpr = "1 + ".repeat(1000);
  const result = await tool.execute("eval", { expression: longExpr }, { maxExpressionLength: 100 });
  assertEquals(result.success, false);
  assert(result.error?.includes("too long"));
});

// ============================================================================
// Precision Tests
// ============================================================================

Deno.test("eval - custom precision", async () => {
  const result = await tool.execute("eval", { expression: "10 / 3", precision: 2 });
  assertEquals(result.success, true);
  assertEquals(result.data?.result, 3.33);
});

Deno.test("eval - default precision", async () => {
  const result = await tool.execute("eval", { expression: "10 / 3" });
  assertEquals(result.success, true);
  // Default is 6 decimal places
  assert(Math.abs(result.data?.result - 3.333333) < 0.0001);
});

// ============================================================================
// Unit Conversion Tests
// ============================================================================

Deno.test("convert - length km to miles", async () => {
  const result = await tool.execute("convert", { value: 100, from: "km", to: "miles" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.converted.value - 62.1371) < 0.01);
});

Deno.test("convert - length feet to meters", async () => {
  const result = await tool.execute("convert", { value: 1, from: "foot", to: "m" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.converted.value - 0.3048) < 0.001);
});

Deno.test("convert - weight lb to kg", async () => {
  const result = await tool.execute("convert", { value: 150, from: "lb", to: "kg" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.converted.value - 68.0389) < 0.01);
});

Deno.test("convert - temperature fahrenheit to celsius", async () => {
  const result = await tool.execute("convert", { value: 32, from: "f", to: "c" });
  assertEquals(result.success, true);
  assertEquals(result.data?.converted.value, 0);
});

Deno.test("convert - temperature celsius to kelvin", async () => {
  const result = await tool.execute("convert", { value: 0, from: "celsius", to: "kelvin" });
  assertEquals(result.success, true);
  assertEquals(result.data?.converted.value, 273.15);
});

Deno.test("convert - volume gallon to liters", async () => {
  const result = await tool.execute("convert", { value: 1, from: "gallon", to: "l" });
  assertEquals(result.success, true);
  assert(Math.abs(result.data?.converted.value - 3.78541) < 0.01);
});

Deno.test("convert - time hours to seconds", async () => {
  const result = await tool.execute("convert", { value: 1, from: "hour", to: "seconds" });
  assertEquals(result.success, true);
  assertEquals(result.data?.converted.value, 3600);
});

Deno.test("convert - data mb to gb", async () => {
  const result = await tool.execute("convert", { value: 1024, from: "mb", to: "gb" });
  assertEquals(result.success, true);
  assertEquals(result.data?.converted.value, 1);
});

Deno.test("convert - incompatible units error", async () => {
  const result = await tool.execute("convert", { value: 1, from: "kg", to: "meters" });
  assertEquals(result.success, false);
  assert(result.error?.includes("same category"));
});

Deno.test("convert - unknown unit error", async () => {
  const result = await tool.execute("convert", { value: 1, from: "parsec", to: "km" });
  assertEquals(result.success, false);
  assert(result.error?.includes("Unknown unit"));
});

// ============================================================================
// Units Command Tests
// ============================================================================

Deno.test("units - list all", async () => {
  const result = await tool.execute("units", {});
  assertEquals(result.success, true);
  assert(result.message?.includes("LENGTH"));
  assert(result.message?.includes("WEIGHT"));
  assert(result.message?.includes("TEMPERATURE"));
});

Deno.test("units - filter by category", async () => {
  const result = await tool.execute("units", { category: "length" });
  assertEquals(result.success, true);
  assert(result.message?.includes("LENGTH"));
  assert(!result.message?.includes("WEIGHT"));
});

Deno.test("units - invalid category", async () => {
  const result = await tool.execute("units", { category: "invalid" });
  assertEquals(result.success, false);
  assert(result.error?.includes("Unknown category"));
});

// ============================================================================
// Functions Command Tests
// ============================================================================

Deno.test("functions - list all", async () => {
  const result = await tool.execute("functions", {});
  assertEquals(result.success, true);
  assert(result.message?.includes("FUNCTIONS"));
  assert(result.message?.includes("CONSTANTS"));
  assert(result.data?.functions?.includes("sqrt"));
  assert(result.data?.functions?.includes("sin"));
});

// ============================================================================
// Helper Function Tests
// ============================================================================

Deno.test("evaluateExpression - basic", () => {
  const result = evaluateExpression("2 + 2");
  assertEquals(result, 4);
});

Deno.test("evaluateExpression - complex", () => {
  const result = evaluateExpression("sqrt(16) + pow(2, 3)");
  assertEquals(result, 12);
});

Deno.test("convertUnit - basic conversion", () => {
  const result = convertUnit(1, "km", "m");
  assertEquals(result, 1000);
});

Deno.test("getUnitsByCategory - all categories", () => {
  const result = getUnitsByCategory();
  assert(result["length"] !== undefined);
  assert(result["weight"] !== undefined);
  assert(result["temperature"] !== undefined);
});

Deno.test("getUnitsByCategory - specific category", () => {
  const result = getUnitsByCategory("length");
  assert(result["length"] !== undefined);
  assertEquals(Object.keys(result).length, 1);
});

// ============================================================================
// Message Formatting Tests
// ============================================================================

Deno.test("eval - formatted message", async () => {
  const result = await tool.execute("eval", { expression: "2 + 2" });
  assertEquals(result.message, "2 + 2 = 4");
});

Deno.test("convert - formatted message", async () => {
  const result = await tool.execute("convert", { value: 100, from: "km", to: "miles" });
  assert(result.message?.includes("100 km"));
  assert(result.message?.includes("62.137"));
  assert(result.message?.includes("miles"));
});

console.log("All tests defined!");
