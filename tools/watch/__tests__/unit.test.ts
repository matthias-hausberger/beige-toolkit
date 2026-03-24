import { describe, it, beforeEach, afterEach } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { assertEquals, assertMatch, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Import the watcher tool
const watcherModule = await import("../index.ts");
const watcher = watcherModule.default;

const TEST_DIR = "/tmp/watch-test";

// Helper to wait
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("File Watcher Tool", () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clear all watchers
    await watcher({ command: "clear" }, {});
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("start command", () => {
    it("should start watching a directory", async () => {
      const result = await watcher(
        { command: "start", path: TEST_DIR },
        {}
      );

      assertEquals(result.success, true);
      assert(result.watcherId !== undefined);
      assertMatch(result.watcherId!, /^watch-/);
    });

    it("should require path parameter", async () => {
      const result = await watcher({ command: "start" }, {});

      assertEquals(result.success, false);
      assert(result.error!.includes("Path is required"));
    });

    it("should fail for non-existent path", async () => {
      const result = await watcher(
        { command: "start", path: "/non/existent/path" },
        {}
      );

      assertEquals(result.success, false);
      assert(result.error!.includes("does not exist"));
    });

    it("should respect allowPaths config", async () => {
      const result = await watcher(
        { command: "start", path: TEST_DIR },
        { config: { allowPaths: ["/other/**"] } }
      );

      assertEquals(result.success, false);
      assert(result.error!.includes("not in allow list"));
    });

    it("should respect denyPaths config", async () => {
      const result = await watcher(
        { command: "start", path: TEST_DIR },
        { config: { denyPaths: ["/tmp/**"] } }
      );

      assertEquals(result.success, false);
      assert(result.error!.includes("deny list"));
    });

    it("should enforce maxWatchers limit", async () => {
      const config = { maxWatchers: 2 };

      // Start 2 watchers
      await watcher({ command: "start", path: TEST_DIR }, { config });
      await watcher({ command: "start", path: TEST_DIR }, { config });

      // Third should fail
      const result = await watcher(
        { command: "start", path: TEST_DIR },
        { config }
      );

      assertEquals(result.success, false);
      assert(result.error!.includes("Maximum number of watchers"));
    });

    it("should accept custom events", async () => {
      const result = await watcher(
        { command: "start", path: TEST_DIR, events: ["modify"] },
        {}
      );

      assertEquals(result.success, true);
    });

    it("should accept glob pattern", async () => {
      const result = await watcher(
        { command: "start", path: TEST_DIR, pattern: "**/*.ts" },
        {}
      );

      assertEquals(result.success, true);
    });

    it("should accept commandOnEvent", async () => {
      const result = await watcher(
        { command: "start", path: TEST_DIR, commandOnEvent: "echo test" },
        {}
      );

      assertEquals(result.success, true);
    });
  });

  describe("stop command", () => {
    it("should stop an active watcher", async () => {
      const startResult = await watcher(
        { command: "start", path: TEST_DIR },
        {}
      );

      const result = await watcher(
        { command: "stop", watcherId: startResult.watcherId },
        {}
      );

      assertEquals(result.success, true);
    });

    it("should fail for non-existent watcher", async () => {
      const result = await watcher(
        { command: "stop", watcherId: "watch-nonexistent" },
        {}
      );

      assertEquals(result.success, false);
      assert(result.error!.includes("not found"));
    });

    it("should require watcherId parameter", async () => {
      const result = await watcher({ command: "stop" }, {});

      assertEquals(result.success, false);
      assert(result.error!.includes("watcherId is required"));
    });
  });

  describe("list command", () => {
    it("should list active watchers", async () => {
      await watcher({ command: "start", path: TEST_DIR }, {});
      await watcher({ command: "start", path: TEST_DIR }, {});

      const result = (await watcher({ command: "list" }, {})) as {
        watchers: unknown[];
      };

      assertEquals(result.watchers.length, 2);
    });

    it("should return empty array when no watchers", async () => {
      const result = (await watcher({ command: "list" }, {})) as {
        watchers: unknown[];
      };

      assertEquals(result.watchers.length, 0);
    });

    it("should include watcher details", async () => {
      await watcher(
        { command: "start", path: TEST_DIR, pattern: "**/*.ts" },
        {}
      );

      const result = (await watcher({ command: "list" }, {})) as {
        watchers: Array<{ path: string; pattern: string }>;
      };

      assertEquals(result.watchers[0].path, TEST_DIR);
      assertEquals(result.watchers[0].pattern, "**/*.ts");
    });
  });

  describe("clear command", () => {
    it("should stop all watchers", async () => {
      await watcher({ command: "start", path: TEST_DIR }, {});
      await watcher({ command: "start", path: TEST_DIR }, {});

      const result = (await watcher({ command: "clear" }, {})) as {
        count: number;
      };

      assertEquals(result.count, 2);

      const list = (await watcher({ command: "list" }, {})) as {
        watchers: unknown[];
      };
      assertEquals(list.watchers.length, 0);
    });

    it("should return 0 when no watchers", async () => {
      const result = (await watcher({ command: "clear" }, {})) as {
        count: number;
      };

      assertEquals(result.count, 0);
    });
  });

  describe("history command", () => {
    it("should show recent events", async () => {
      const result = (await watcher({ command: "history" }, {})) as {
        events: unknown[];
      };

      assert(result.events !== undefined);
      assert(Array.isArray(result.events));
    });

    it("should respect limit parameter", async () => {
      const result = (await watcher(
        { command: "history", limit: 10 },
        {}
      )) as { events: unknown[] };

      assert(result.events.length <= 10);
    });
  });

  describe("unknown command", () => {
    it("should return error for unknown command", async () => {
      const result = await watcher({ command: "unknown" }, {});

      assertEquals(result.success, false);
      assert(result.error!.includes("Unknown command"));
    });
  });
});
