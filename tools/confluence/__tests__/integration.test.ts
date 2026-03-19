/**
 * Integration tests for the confluence tool.
 *
 * Covers manifest validity and end-to-end permission + executor flows
 * representing realistic agent configurations.  No real confluence process
 * is spawned.
 */

import { describe, it, expect } from "vitest";
import { loadToolManifest } from "../../../test-utils/loadManifest.js";
import { assertValidToolManifest } from "../../../test-utils/assertions.js";
import { createHandler, type Executor } from "../index.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("tool manifest", () => {
  const manifest = loadToolManifest("tools/confluence");

  it("is valid", () => {
    assertValidToolManifest(manifest);
  });

  it("has name confluence", () => {
    expect(manifest.name).toBe("confluence");
  });

  it("target is gateway", () => {
    expect(manifest.target).toBe("gateway");
  });

  it("lists at least one command example", () => {
    expect(manifest.commands?.length).toBeGreaterThan(0);
  });

  it("commands cover read, search, create, update, and delete", () => {
    const cmds = manifest.commands?.join(" ") ?? "";
    expect(cmds).toContain("read");
    expect(cmds).toContain("search");
    expect(cmds).toContain("create");
    expect(cmds).toContain("update");
    expect(cmds).toContain("delete");
  });
});

// ---------------------------------------------------------------------------
// Stub executor helpers
// ---------------------------------------------------------------------------

function makeExecutor(
  response: string = "ok",
  exitCode = 0
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: response, stderr: "", exitCode };
    },
    { calls }
  );
}

/**
 * Executor that returns space info for specific page IDs and a normal
 * response for all other calls.
 */
function makeInfoExecutor(
  pageSpaceMap: Record<string, string>,
  defaultResponse = "ok"
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const infoIdx = args.indexOf("info");
      if (infoIdx !== -1 && infoIdx + 1 < args.length) {
        const pageId = args[infoIdx + 1];
        if (pageSpaceMap[pageId]) {
          return {
            stdout: `Title: Some Page\nSpace: ${pageSpaceMap[pageId]}\nURL: https://example.atlassian.net`,
            stderr: "",
            exitCode: 0,
          };
        }
      }
      return { stdout: defaultResponse, stderr: "", exitCode: 0 };
    },
    { calls }
  );
}

// ---------------------------------------------------------------------------
// Command-level: read-only agent (denyCommands)
// ---------------------------------------------------------------------------

describe("read-only agent config (command-level)", () => {
  const config = {
    denyCommands: [
      "create", "update", "delete", "move", "edit",
      "attachment-upload", "attachment-delete",
      "comment", "comment-delete",
      "property-set", "property-delete",
      "copy-tree",
    ],
  };

  it("can read a page", async () => {
    const exec = makeExecutor("Page content");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["read", "123456789"])).exitCode).toBe(0);
  });

  it("can search", async () => {
    const exec = makeExecutor("result 1\nresult 2");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["search", "API docs", "--limit", "5"])).exitCode).toBe(0);
  });

  it("can list spaces", async () => {
    const exec = makeExecutor("SPACE1\nSPACE2");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["spaces"])).exitCode).toBe(0);
  });

  it("can list children", async () => {
    const exec = makeExecutor("child 1\nchild 2");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["children", "123456789", "--recursive"]);
    expect(result.exitCode).toBe(0);
  });

  it("cannot create a page", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create", "My Page", "SPACE", "--content", "hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot create-child ('create' prefix blocks it)", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create-child", "Child", "123456789"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot update a page", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["update", "123456789", "--content", "new"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot delete a page", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["delete", "123456789", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Command-level: strictly scoped agent (allowCommands)
// ---------------------------------------------------------------------------

describe("strictly scoped read-only agent (command-level)", () => {
  const config = { allowCommands: ["read", "search", "info", "spaces", "find", "children"] };

  it("can read a page", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["read", "123"])).exitCode).toBe(0);
  });

  it("cannot create", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create", "Title", "SPACE"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot manage profiles", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["profile", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Command-level: default config — all commands allowed
// ---------------------------------------------------------------------------

describe("default config — all commands allowed", () => {
  it("allows read", async () => {
    const exec = makeExecutor("content");
    expect((await createHandler({}, { executor: exec })(["read", "123"])).exitCode).toBe(0);
  });

  it("allows create", async () => {
    const exec = makeExecutor("created");
    expect((await createHandler({}, { executor: exec })(["create", "Title", "SPACE"])).exitCode).toBe(0);
  });

  it("allows delete", async () => {
    const exec = makeExecutor("deleted");
    expect((await createHandler({}, { executor: exec })(["delete", "123", "--yes"])).exitCode).toBe(0);
  });

  it("allows stats", async () => {
    const exec = makeExecutor("stats output");
    expect((await createHandler({}, { executor: exec })(["stats"])).exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Space-level: read-only agent restricted to specific spaces
// ---------------------------------------------------------------------------

describe("space-restricted read-only agent", () => {
  const config = { allowReadSpaces: ["TEAM", "DOCS"] };

  it("can read a page in TEAM (URL, free resolution)", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler(config, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/TEAM/pages/111",
    ]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args[0]).toBe("read");
  });

  it("can read a page in DOCS (URL, free resolution)", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler(config, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/DOCS/pages/222",
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("cannot read a page in a forbidden space (URL)", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/SECRET/pages/333",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("SECRET");
    expect(exec.calls).toHaveLength(0);
  });

  it("can read a page by ID that resolves to TEAM (Tier 2)", async () => {
    const exec = makeInfoExecutor({ "444": "TEAM" }, "page content");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["read", "444"]);
    expect(result.exitCode).toBe(0);
    const infoCall = exec.calls.find(c => c.args.includes("info"));
    expect(infoCall).toBeDefined();
  });

  it("cannot read a page by ID that resolves to a forbidden space (Tier 2)", async () => {
    const exec = makeInfoExecutor({ "555": "PRIVATE" });
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["read", "555"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("PRIVATE");
    // info was called, read was not
    const readCall = exec.calls.find(c => c.args.includes("read"));
    expect(readCall).toBeUndefined();
  });

  it("can still run spaces (agnostic command)", async () => {
    const exec = makeExecutor("SPACE1");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["spaces"])).exitCode).toBe(0);
  });

  it("has no space restriction on write when allowWriteSpaces is not set", async () => {
    const exec = makeInfoExecutor({ "666": "ANYWHERESPACE" }, "updated");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["update", "666", "--content", "x"]);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Space-level: write restricted to specific spaces
// ---------------------------------------------------------------------------

describe("space-restricted write agent", () => {
  const config = { allowWriteSpaces: ["DRAFTS"] };

  it("can create in DRAFTS (Tier 1)", async () => {
    const exec = makeExecutor("created");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create", "My Page", "DRAFTS", "--content", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args[0]).toBe("create");
  });

  it("cannot create in TEAM (Tier 1)", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create", "My Page", "TEAM", "--content", "hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("can update a page in DRAFTS (Tier 2)", async () => {
    const exec = makeInfoExecutor({ "111": "DRAFTS" }, "updated");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["update", "111", "--content", "new"]);
    expect(result.exitCode).toBe(0);
  });

  it("cannot update a page in a different space (Tier 2)", async () => {
    const exec = makeInfoExecutor({ "222": "PROTECTED" });
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["update", "222", "--content", "new"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("PROTECTED");
  });

  it("has no space restriction on reads when allowReadSpaces is not set", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler(config, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/ANYTHING/pages/123",
    ]);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Space-level: combined read + write space restrictions
// ---------------------------------------------------------------------------

describe("combined read + write space restrictions", () => {
  const config = {
    allowReadSpaces: ["DOCS", "TEAM"],
    allowWriteSpaces: ["DRAFTS"],
  };

  it("can read from DOCS", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler(config, { executor: exec });
    expect((await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/DOCS/pages/1",
    ])).exitCode).toBe(0);
  });

  it("cannot read from DRAFTS (not in allowReadSpaces)", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/DRAFTS/pages/1",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("can write to DRAFTS", async () => {
    const exec = makeExecutor("created");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["create", "X", "DRAFTS"])).exitCode).toBe(0);
  });

  it("cannot write to DOCS (not in allowWriteSpaces)", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create", "X", "DOCS"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Space-level: copy-tree both IDs must pass
// ---------------------------------------------------------------------------

describe("copy-tree space enforcement", () => {
  const config = { allowWriteSpaces: ["TEAM"] };

  it("allows when both source and target are in TEAM", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM", "222": "TEAM" }, "ok");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["copy-tree", "111", "222", "Copy"])).exitCode).toBe(0);
  });

  it("blocks when source is in a forbidden space", async () => {
    const exec = makeInfoExecutor({ "111": "PRIVATE", "222": "TEAM" });
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["copy-tree", "111", "222", "Copy"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("blocks when target parent is in a forbidden space", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM", "222": "PRIVATE" });
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["copy-tree", "111", "222", "Copy"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Space-level: requireSpaceOnSearch end-to-end
// ---------------------------------------------------------------------------

describe("requireSpaceOnSearch end-to-end", () => {
  const config = { allowReadSpaces: ["TEAM"], requireSpaceOnSearch: true };

  it("blocks search without --space", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["search", "important docs"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("requireSpaceOnSearch");
    expect(result.output).toContain("CQL");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows search with permitted --space", async () => {
    const exec = makeExecutor("results");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["search", "important docs", "--space", "TEAM"]);
    expect(result.exitCode).toBe(0);
  });

  it("blocks search with forbidden --space", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["search", "important docs", "--space", "SECRET"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("SECRET");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Space-level: comment-delete is agnostic (see disclaimer)
// ---------------------------------------------------------------------------

describe("comment-delete is not subject to space enforcement", () => {
  it("is allowed even when allowWriteSpaces is restrictive", async () => {
    const exec = makeExecutor("deleted");
    const handler = createHandler({ allowWriteSpaces: ["TEAM"] }, { executor: exec });
    const result = await handler(["comment-delete", "998877", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deny beats allow (command-level, existing)
// ---------------------------------------------------------------------------

describe("deny beats allow", () => {
  it("denyCommands overrides allowCommands for the same path", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { allowCommands: ["delete", "read"], denyCommands: ["delete"] },
      { executor: exec }
    );
    const denied = await handler(["delete", "123", "--yes"]);
    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("Permission denied");

    const allowed = await handler(["read", "123"]);
    expect(allowed.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Profile injection integration (existing)
// ---------------------------------------------------------------------------

describe("profile injection", () => {
  it("prepends --profile before subcommand", async () => {
    const exec = makeExecutor("spaces");
    const handler = createHandler({ profile: "production" }, { executor: exec });
    await handler(["spaces"]);
    expect(exec.calls[0].args).toEqual(["--profile", "production", "spaces"]);
  });

  it("respects agent-provided --profile over configured default", async () => {
    const exec = makeExecutor("spaces");
    const handler = createHandler({ profile: "production" }, { executor: exec });
    await handler(["--profile", "staging", "spaces"]);
    const args = exec.calls[0].args;
    expect(args[args.indexOf("--profile") + 1]).toBe("staging");
    expect(args.filter((a) => a === "--profile")).toHaveLength(1);
  });

  it("profile is forwarded to Tier 2 info lookups", async () => {
    const exec = makeInfoExecutor({ "111": "DOCS" }, "ok");
    const handler = createHandler(
      { allowWriteSpaces: ["DOCS"], profile: "prod" },
      { executor: exec }
    );
    await handler(["update", "111", "--content", "x"]);
    const infoCall = exec.calls.find(c => c.args.includes("info"));
    expect(infoCall?.args).toContain("--profile");
    expect(infoCall?.args).toContain("prod");
  });
});

// ---------------------------------------------------------------------------
// Exit code passthrough (existing)
// ---------------------------------------------------------------------------

describe("exit code passthrough", () => {
  it("passes non-zero exit code from confluence through unchanged", async () => {
    const exec = makeExecutor("Error: page not found", 1);
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "999999"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("page not found");
  });
});
