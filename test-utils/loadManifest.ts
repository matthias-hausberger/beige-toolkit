import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface ToolManifest {
  name: string;
  description: string;
  commands?: string[];
  target: "gateway" | "sandbox";
}

/**
 * Load and parse tool.json from the given tool directory.
 * Throws if the file is missing or malformed.
 */
export function loadToolManifest(toolPath: string): ToolManifest {
  const manifestPath = resolve(toolPath, "tool.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`tool.json not found at: ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as ToolManifest;
}
