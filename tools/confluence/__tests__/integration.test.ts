/**
 * Integration tests for the confluence tool.
 *
 * Covers manifest validity and end-to-end permission + executor flows
 * representing realistic agent configurations.  No real confluence process
 * is spawned.
 */

import { describe, it, expect } from "vitest";
import { loadToolManifest } from "../../../test-utils/loadToolkitManifest.js";
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
// Stub executor
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

// ---------------------------------------------------------------------------
// Read-only agent (denyCommands: create, update, delete, move, etc.)
// ---------------------------------------------------------------------------

describe("read-only agent config", () => {
  const config = {
    denyCommands: [
      "create",
      "update",
      "delete",
      "move",
      "edit",
      "attachment-upload",
      "attachment-delete",
      "comment",
      "comment-delete",
      "property-set",
      "property-delete",
      "copy-tree",
    ],
  };

  it("can read a page", async () => {
    const exec = makeExecutor("Page content");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Page content");
  });

  it("can search", async () => {
    const exec = makeExecutor("result 1\nresult 2");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["search", "API docs", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("result 1");
  });

  it("can list spaces", async () => {
    const exec = makeExecutor("SPACE1\nSPACE2");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["spaces"]);
    expect(result.exitCode).toBe(0);
  });

  it("can list children", async () => {
    const exec = makeExecutor("child 1\nchild 2");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["children", "123456789", "--recursive"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls[0].args[0]).toBe("children");
  });

  it("can list attachments (read-only)", async () => {
    const exec = makeExecutor("file.pdf");
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["attachments", "123456789"]);
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

  it("cannot create a child page ('create' prefix blocks 'create-child')", async () => {
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
// Strictly scoped agent (allowCommands: read, search, info, spaces only)
// ---------------------------------------------------------------------------

describe("strictly scoped read-only agent", () => {
  const config = {
    allowCommands: ["read", "search", "info", "spaces", "find", "children"],
  };

  it("can read a page", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["read", "123"])).exitCode).toBe(0);
  });

  it("can search", async () => {
    const exec = makeExecutor("results");
    const handler = createHandler(config, { executor: exec });
    expect((await handler(["search", "term"])).exitCode).toBe(0);
  });

  it("cannot create (not in allowlist)", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["create", "Title", "SPACE"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("cannot update", async () => {
    const exec = makeExecutor();
    const handler = createHandler(config, { executor: exec });
    const result = await handler(["update", "123", "--content", "new"]);
    expect(result.exitCode).toBe(1);
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
// Default config — all commands allowed
// ---------------------------------------------------------------------------

describe("default config — all commands allowed", () => {
  it("allows read", async () => {
    const exec = makeExecutor("content");
    const handler = createHandler({}, { executor: exec });
    expect((await handler(["read", "123"])).exitCode).toBe(0);
  });

  it("allows create", async () => {
    const exec = makeExecutor("created");
    const handler = createHandler({}, { executor: exec });
    expect((await handler(["create", "Title", "SPACE"])).exitCode).toBe(0);
  });

  it("allows delete", async () => {
    const exec = makeExecutor("deleted");
    const handler = createHandler({}, { executor: exec });
    expect((await handler(["delete", "123", "--yes"])).exitCode).toBe(0);
  });

  it("allows profile management", async () => {
    const exec = makeExecutor("profiles listed");
    const handler = createHandler({}, { executor: exec });
    expect((await handler(["profile", "list"])).exitCode).toBe(0);
  });

  it("allows stats", async () => {
    const exec = makeExecutor("stats output");
    const handler = createHandler({}, { executor: exec });
    expect((await handler(["stats"])).exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deny beats allow
// ---------------------------------------------------------------------------

describe("deny beats allow", () => {
  it("denyCommands overrides allowCommands for the same path", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      {
        allowCommands: ["delete", "read"],
        denyCommands: ["delete"],
      },
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
// Profile injection integration
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
    const idx = args.indexOf("--profile");
    expect(args[idx + 1]).toBe("staging");
    expect(args.filter((a) => a === "--profile")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Exit code passthrough
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
