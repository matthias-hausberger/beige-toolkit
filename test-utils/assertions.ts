import { expect } from "vitest";
import type { PluginManifest } from "./loadManifest.js";

/** @deprecated Use PluginManifest */
export type ToolManifest = PluginManifest;

/**
 * Assert that a plugin manifest has all required fields.
 */
export function assertValidPluginManifest(manifest: unknown): asserts manifest is PluginManifest {
  expect(manifest).toBeDefined();
  expect(typeof (manifest as PluginManifest).name).toBe("string");
  expect((manifest as PluginManifest).name.length).toBeGreaterThan(0);
  expect(typeof (manifest as PluginManifest).description).toBe("string");
  expect((manifest as PluginManifest).description.length).toBeGreaterThan(0);
}

/** @deprecated Use assertValidPluginManifest */
export const assertValidToolManifest = assertValidPluginManifest;

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
