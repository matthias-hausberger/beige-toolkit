import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { createHandler } from "../index.js";
import { createFakeGhClient } from "../../../test-utils/createFakeGhClient.js";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import { assertValidToolManifest, assertSuccess, assertFailure } from "../../../test-utils/assertions.js";

const TOOL_DIR = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("plugin.json", () => {
  it("is valid and complete", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    assertValidToolManifest(manifest);
  });

  it("is named 'github'", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    expect(manifest.name).toBe("github");
  });

  it("provides the github tool", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    expect(manifest.provides).toEqual({ tools: ["github"] });
  });

  it("has at least one documented command", () => {
    const manifest = loadToolManifest(TOOL_DIR);
    expect(manifest.commands).toBeDefined();
    expect(manifest.commands!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Handler lifecycle
// ---------------------------------------------------------------------------

describe("createHandler", () => {
  it("returns a callable function", () => {
    const handler = createHandler({});
    expect(typeof handler).toBe("function");
  });

  it("accepts an empty config object", () => {
    expect(() => createHandler({})).not.toThrow();
  });

  it("accepts allowedCommands and deniedCommands config", () => {
    expect(() =>
      createHandler({ allowedCommands: ["repo"], deniedCommands: ["api"] })
    ).not.toThrow();
  });

  it("accepts a token config value", () => {
    expect(() => createHandler({ token: "ghp_abc123" })).not.toThrow();
  });

  it("accepts a fine-grained PAT token config value", () => {
    expect(() =>
      createHandler({ token: "github_pat_11AABBCC_longfinegrainedsecret" })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow with fake gh client
// ---------------------------------------------------------------------------

describe("end-to-end with fake gh", () => {
  it("executes a repo list and returns results", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], {
      stdout: "myorg/frontend\nmyorg/backend\n",
      exitCode: 0,
    });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["repo", "list"]);

    assertSuccess(result);
    expect(result.output).toContain("myorg/frontend");
    expect(result.output).toContain("myorg/backend");
  });

  it("executes an issue list scoped to a repo", async () => {
    const fake = createFakeGhClient();
    fake.register(["issue", "list", "--repo", "myorg/myrepo"], {
      stdout: "#1\tBug: crash on startup\topen\n#2\tFeat: dark mode\topen\n",
      exitCode: 0,
    });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["issue", "list", "--repo", "myorg/myrepo"]);

    assertSuccess(result);
    expect(result.output).toContain("Bug: crash on startup");
  });

  it("surfaces gh error output clearly", async () => {
    const fake = createFakeGhClient();
    fake.register(["pr", "view", "999", "--repo", "myorg/myrepo"], {
      stderr: "pull request #999 not found",
      exitCode: 1,
    });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["pr", "view", "999", "--repo", "myorg/myrepo"]);

    assertFailure(result);
    expect(result.output).toContain("pull request #999 not found");
  });

  it("forwards the configured token to the executor", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo\n", exitCode: 0 });

    const handler = createHandler(
      { token: "ghp_integrationtoken" },
      { executor: fake.run }
    );
    const result = await handler(["repo", "list"]);

    assertSuccess(result);
    expect(fake.tokens[0]).toBe("ghp_integrationtoken");
  });

  it("passes no token when config.token is absent", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo\n", exitCode: 0 });

    const handler = createHandler({}, { executor: fake.run });
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBeUndefined();
  });

  it("respects access-control in the full flow", async () => {
    const fake = createFakeGhClient();
    // register a response that should never be reached
    fake.register(["repo", "list"], { stdout: "should not appear", exitCode: 0 });

    const handler = createHandler(
      { allowedCommands: ["issue"] },
      { executor: fake.run }
    );

    const result = await handler(["repo", "list"]);
    assertFailure(result);
    expect(result.output).toContain("Permission denied");
    // The executor should not have been called
    expect(fake.calls).toHaveLength(0);
  });
});
