import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";

const TOOLKIT_ROOT = resolve(import.meta.dirname, "..");
const PLUGINS_DIR = resolve(TOOLKIT_ROOT, "plugins");

interface PluginManifest {
  name: string;
  description: string;
  commands?: string[];
  provides?: { tools?: string[]; channel?: boolean };
  defaultConfig?: Record<string, unknown>;
}

function discoverPluginDirs(): Array<{ path: string; name: string }> {
  const dirs: Array<{ path: string; name: string }> = [];

  for (const entry of readdirSync(PLUGINS_DIR)) {
    const p = resolve(PLUGINS_DIR, entry);
    if (statSync(p).isDirectory() && existsSync(resolve(p, "plugin.json"))) {
      dirs.push({ path: p, name: entry });
    }
  }

  return dirs;
}

function loadManifest(pluginPath: string): PluginManifest {
  const raw = readFileSync(resolve(pluginPath, "plugin.json"), "utf-8");
  return JSON.parse(raw);
}

describe("plugin discovery", () => {
  const pluginDirs = discoverPluginDirs();

  it("finds at least one plugin", () => {
    expect(pluginDirs.length).toBeGreaterThan(0);
  });

  for (const { path: pluginDir, name: pluginName } of pluginDirs) {
    describe(`plugin: ${pluginName}`, () => {
      it("plugin.json is valid", () => {
        const manifest = loadManifest(pluginDir);
        expect(typeof manifest.name).toBe("string");
        expect(manifest.name.length).toBeGreaterThan(0);
        expect(typeof manifest.description).toBe("string");
        expect(manifest.description.length).toBeGreaterThan(0);
      });

      it("index.ts exists", () => {
        expect(existsSync(resolve(pluginDir, "index.ts"))).toBe(true);
      });

      it("README.md exists", () => {
        expect(existsSync(resolve(pluginDir, "README.md"))).toBe(true);
      });

      it("exports createPlugin", async () => {
        const mod = await import(resolve(pluginDir, "index.ts"));
        expect(typeof mod.createPlugin).toBe("function");
      });

      it("exports createHandler for backward compat (if not a pure plugin)", async () => {
        const mod = await import(resolve(pluginDir, "index.ts"));
        // createHandler is optional for pure-plugin implementations (like telegram)
        if (mod.createHandler) {
          expect(typeof mod.createHandler).toBe("function");
        }
      });
    });
  }
});
