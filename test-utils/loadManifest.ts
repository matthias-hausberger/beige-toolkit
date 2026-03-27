import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface PluginManifest {
  name: string;
  description: string;
  commands?: string[];
  provides?: {
    tools?: string[];
    channel?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
}

/** @deprecated Use loadPluginManifest instead */
export type ToolManifest = PluginManifest;

/**
 * Load and parse plugin.json from the given plugin directory.
 * Throws if the file is missing or malformed.
 */
export function loadPluginManifest(pluginPath: string): PluginManifest {
  const manifestPath = resolve(pluginPath, "plugin.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`plugin.json not found at: ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as PluginManifest;
}

/** @deprecated Use loadPluginManifest instead */
export const loadToolManifest = loadPluginManifest;
