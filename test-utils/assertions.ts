import { expect } from "vitest";
import type { ToolManifest } from "./loadManifest.js";

/**
 * Assert that a tool manifest has all required fields.
 */
export function assertValidToolManifest(manifest: unknown): asserts manifest is ToolManifest {
  expect(manifest).toBeDefined();
  expect(typeof (manifest as ToolManifest).name).toBe("string");
  expect((manifest as ToolManifest).name.length).toBeGreaterThan(0);
  expect(typeof (manifest as ToolManifest).description).toBe("string");
  expect((manifest as ToolManifest).description.length).toBeGreaterThan(0);
  expect(["gateway", "sandbox"]).toContain((manifest as ToolManifest).target);
}

/**
 * Assert a tool result indicates success.
 */
export function assertSuccess(result: { output: string; exitCode: number }): void {
  expect(result.exitCode).toBe(0);
}

/**
 * Assert a tool result indicates failure.
 */
export function assertFailure(result: { output: string; exitCode: number }): void {
  expect(result.exitCode).not.toBe(0);
}
