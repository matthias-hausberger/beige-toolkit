import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "path";
import { existsSync, cpSync, rmSync, readdirSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";

const TOOLKIT_ROOT = resolve(import.meta.dirname, "..");

/**
 * Simulates what beige does when installing from npm:
 * - copies the published files to a temp directory (excluding node_modules/.git)
 * - validates that all plugins are discoverable and importable from the copy
 *
 * This checks the installable artifact shape without needing a running Beige.
 */
describe("install smoke", () => {
  const tmpPath = resolve(tmpdir(), `beige-toolkit-smoke-${Date.now()}`);

  afterAll(() => {
    try {
      rmSync(tmpPath, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("toolkit root can be copied to a temp install path", () => {
    cpSync(TOOLKIT_ROOT, tmpPath, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes(".git"),
    });
    expect(existsSync(resolve(tmpPath, "plugins"))).toBe(true);
  });

  it("all plugins are discoverable from the install path", () => {
    const dirs = [resolve(tmpPath, "plugins")];
    let found = 0;

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const pluginDirs = readdirSync(dir)
        .map((e) => resolve(dir, e))
        .filter((p) => statSync(p).isDirectory())
        .filter((p) => existsSync(resolve(p, "plugin.json")));

      for (const pluginDir of pluginDirs) {
        const raw = readFileSync(resolve(pluginDir, "plugin.json"), "utf-8");
        const manifest = JSON.parse(raw);
        expect(typeof manifest.name).toBe("string");
        expect(typeof manifest.description).toBe("string");
        found++;
      }
    }

    expect(found).toBeGreaterThan(0);
  });

  it("all plugin entry points are importable from the install path", async () => {
    const pluginsDir = resolve(tmpPath, "plugins");
    const pluginDirs = readdirSync(pluginsDir)
      .map((e) => resolve(pluginsDir, e))
      .filter((p) => statSync(p).isDirectory())
      .filter((p) => existsSync(resolve(p, "plugin.json")));

    for (const pluginDir of pluginDirs) {
      const handlerPath = resolve(pluginDir, "index.ts");
      expect(existsSync(handlerPath)).toBe(true);

      const mod = await import(handlerPath);
      expect(typeof mod.createPlugin).toBe("function");
    }
  });
});
