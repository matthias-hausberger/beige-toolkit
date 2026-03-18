/**
 * Unit tests for the confluence tool handler.
 *
 * All tests use an injected executor stub — no real confluence process is
 * spawned.  Tests are fast and deterministic.
 */

import { describe, it, expect } from "vitest";
import {
  createHandler,
  extractCommandPath,
  checkPermission,
  checkSpacePermission,
  classifyCommand,
  extractSpaceFromUrl,
  extractFlag,
  extractFirstPositional,
  extractSecondPositional,
  isPageId,
  parseSpaceFromInfoOutput,
  resolveSpaceKey,
  enforceSpacePolicy,
  type ExecResult,
  type Executor,
  type ConfluenceConfig,
} from "../index.js";

// ---------------------------------------------------------------------------
// Stub executor helpers
// ---------------------------------------------------------------------------

function makeExecutor(
  result: Partial<ExecResult> = {}
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const executor: Executor & { calls: typeof calls } = Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {
        stdout: result.stdout ?? "ok",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    { calls }
  );
  return executor;
}

/**
 * Build an executor that returns a fixed info response for specific page IDs
 * and a default response for everything else.
 */
function makeInfoExecutor(
  pageSpaceMap: Record<string, string>,
  defaultStdout = "ok"
): Executor & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const executor: Executor & { calls: typeof calls } = Object.assign(
    async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // Detect info calls by the presence of "info" as an arg token
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
      return { stdout: defaultStdout, stderr: "", exitCode: 0 };
    },
    { calls }
  );
  return executor;
}

function makeNotFoundExecutor(): Executor {
  return async () => ({
    stdout: "",
    stderr: "confluence not found on PATH. Install it with: brew install pchuri/tap/confluence-cli  or  npm install -g confluence-cli",
    exitCode: 127,
  });
}

// ---------------------------------------------------------------------------
// extractCommandPath
// ---------------------------------------------------------------------------

describe("extractCommandPath", () => {
  it("extracts single-token command", () => {
    expect(extractCommandPath(["read"])).toBe("read");
  });

  it("extracts two-token command path (profile subcommand)", () => {
    expect(extractCommandPath(["profile", "list"])).toBe("profile list");
  });

  it("profile captures second token, stops before positional arg", () => {
    expect(extractCommandPath(["profile", "use", "staging"])).toBe("profile use");
  });

  it("stops after subcommand — positional args are not subcommand tokens", () => {
    expect(extractCommandPath(["search", "my query", "--limit", "5"])).toBe("search");
  });

  it("stops at first flag for single-token paths", () => {
    expect(extractCommandPath(["read", "--format", "markdown"])).toBe("read");
  });

  it("returns empty string for flag-only args", () => {
    expect(extractCommandPath(["--help"])).toBe("");
  });

  it("returns empty string for empty args", () => {
    expect(extractCommandPath([])).toBe("");
  });

  it("stops at -- separator", () => {
    expect(extractCommandPath(["search", "--", "query"])).toBe("search");
  });

  it("skips leading --profile flag and its value", () => {
    expect(extractCommandPath(["--profile", "staging", "read", "123"])).toBe("read");
  });

  it("skips --profile and still captures two-token profile path", () => {
    expect(extractCommandPath(["--profile", "staging", "profile", "list"])).toBe("profile list");
  });

  it("extracts create-child as single token — positional args ignored", () => {
    expect(extractCommandPath(["create-child", "My Page", "123456"])).toBe("create-child");
  });
});

// ---------------------------------------------------------------------------
// classifyCommand
// ---------------------------------------------------------------------------

describe("classifyCommand", () => {
  it("classifies read commands correctly", () => {
    for (const cmd of ["read", "info", "children", "attachments", "comments",
      "property-list", "property-get", "export", "edit", "find", "search"]) {
      expect(classifyCommand(cmd)).toBe("read");
    }
  });

  it("classifies write commands correctly", () => {
    for (const cmd of ["create", "create-child", "update", "delete", "move",
      "copy-tree", "attachment-upload", "attachment-delete", "comment",
      "property-set", "property-delete"]) {
      expect(classifyCommand(cmd)).toBe("write");
    }
  });

  it("classifies space-agnostic commands correctly", () => {
    for (const cmd of ["spaces", "stats", "profile", "init", "comment-delete"]) {
      expect(classifyCommand(cmd)).toBe("agnostic");
    }
  });
});

// ---------------------------------------------------------------------------
// extractSpaceFromUrl
// ---------------------------------------------------------------------------

describe("extractSpaceFromUrl", () => {
  it("extracts space key from a Confluence Cloud URL", () => {
    expect(extractSpaceFromUrl(
      "https://example.atlassian.net/wiki/spaces/TEAM/pages/123456789"
    )).toBe("TEAM");
  });

  it("returns uppercased key", () => {
    expect(extractSpaceFromUrl(
      "https://example.atlassian.net/wiki/spaces/docs/pages/123"
    )).toBe("DOCS");
  });

  it("returns null for a plain page ID", () => {
    expect(extractSpaceFromUrl("123456789")).toBeNull();
  });

  it("returns null for a URL without /wiki/spaces/", () => {
    expect(extractSpaceFromUrl("https://example.atlassian.net/wiki/pages/123")).toBeNull();
  });

  it("handles underscores and hyphens in space key", () => {
    expect(extractSpaceFromUrl(
      "https://example.atlassian.net/wiki/spaces/MY_TEAM/pages/1"
    )).toBe("MY_TEAM");
  });
});

// ---------------------------------------------------------------------------
// extractFlag
// ---------------------------------------------------------------------------

describe("extractFlag", () => {
  it("extracts flag value", () => {
    expect(extractFlag(["search", "term", "--space", "TEAM"], "--space")).toBe("TEAM");
  });

  it("returns null when flag is absent", () => {
    expect(extractFlag(["search", "term"], "--space")).toBeNull();
  });

  it("returns null when flag is last token (no value)", () => {
    expect(extractFlag(["search", "--space"], "--space")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFirstPositional / extractSecondPositional
// ---------------------------------------------------------------------------

describe("extractFirstPositional", () => {
  it("returns first positional after subcommand", () => {
    expect(extractFirstPositional(["read", "123456789"])).toBe("123456789");
  });

  it("skips --profile prefix", () => {
    expect(extractFirstPositional(["--profile", "prod", "read", "123"])).toBe("123");
  });

  it("returns null when positional starts with -", () => {
    expect(extractFirstPositional(["read", "--format", "markdown"])).toBeNull();
  });

  it("returns null for empty args", () => {
    expect(extractFirstPositional([])).toBeNull();
  });
});

describe("extractSecondPositional", () => {
  it("returns second positional — create spaceKey", () => {
    expect(extractSecondPositional(["create", "My Page", "DOCS"])).toBe("DOCS");
  });

  it("returns second positional — copy-tree targetParentId", () => {
    expect(extractSecondPositional(["copy-tree", "111", "222"])).toBe("222");
  });

  it("skips --profile prefix", () => {
    expect(extractSecondPositional(["--profile", "prod", "create", "Title", "TEAM"])).toBe("TEAM");
  });

  it("returns null when there is no second positional", () => {
    expect(extractSecondPositional(["update", "123456"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPageId
// ---------------------------------------------------------------------------

describe("isPageId", () => {
  it("returns true for numeric string", () => {
    expect(isPageId("123456789")).toBe(true);
  });

  it("returns false for URL", () => {
    expect(isPageId("https://example.atlassian.net/wiki/spaces/TEAM/pages/123")).toBe(false);
  });

  it("returns false for space key", () => {
    expect(isPageId("TEAM")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPageId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSpaceFromInfoOutput
// ---------------------------------------------------------------------------

describe("parseSpaceFromInfoOutput", () => {
  it("parses space key from typical info output", () => {
    const output = "Title: My Page\nSpace: TEAM\nURL: https://example.atlassian.net";
    expect(parseSpaceFromInfoOutput(output)).toBe("TEAM");
  });

  it("is case-insensitive on the label, uppercases the value", () => {
    expect(parseSpaceFromInfoOutput("space: docs\nTitle: X")).toBe("DOCS");
  });

  it("returns null when no Space: line present", () => {
    expect(parseSpaceFromInfoOutput("Title: My Page\nURL: https://example.atlassian.net")).toBeNull();
  });

  it("handles leading/trailing whitespace around key", () => {
    expect(parseSpaceFromInfoOutput("Space:  MYSPACE  ")).toBe("MYSPACE");
  });
});

// ---------------------------------------------------------------------------
// resolveSpaceKey
// ---------------------------------------------------------------------------

describe("resolveSpaceKey", () => {
  it("extracts from URL without calling executor", async () => {
    const exec = makeExecutor();
    const cache = new Map<string, string>();
    const key = await resolveSpaceKey(
      "https://example.atlassian.net/wiki/spaces/TEAM/pages/123",
      exec, 5000, cache, []
    );
    expect(key).toBe("TEAM");
    expect(exec.calls).toHaveLength(0);
  });

  it("calls confluence info for a numeric page ID", async () => {
    const exec = makeInfoExecutor({ "123456789": "DOCS" });
    const cache = new Map<string, string>();
    const key = await resolveSpaceKey("123456789", exec, 5000, cache, []);
    expect(key).toBe("DOCS");
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args).toContain("info");
    expect(exec.calls[0].args).toContain("123456789");
  });

  it("caches the result and does not call executor a second time", async () => {
    const exec = makeInfoExecutor({ "123456789": "DOCS" });
    const cache = new Map<string, string>();
    await resolveSpaceKey("123456789", exec, 5000, cache, []);
    await resolveSpaceKey("123456789", exec, 5000, cache, []);
    expect(exec.calls).toHaveLength(1);
  });

  it("returns null for a non-URL, non-numeric value", async () => {
    const exec = makeExecutor();
    const cache = new Map<string, string>();
    const key = await resolveSpaceKey("not-a-page-id", exec, 5000, cache, []);
    expect(key).toBeNull();
    expect(exec.calls).toHaveLength(0);
  });

  it("includes --profile in info lookup args when provided", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM" });
    const cache = new Map<string, string>();
    await resolveSpaceKey("111", exec, 5000, cache, ["--profile", "prod"]);
    expect(exec.calls[0].args[0]).toBe("--profile");
    expect(exec.calls[0].args[1]).toBe("prod");
  });

  it("returns null when info output has no Space: line", async () => {
    const exec = makeExecutor({ stdout: "Title: Some Page\nURL: ...", exitCode: 0 });
    const cache = new Map<string, string>();
    const key = await resolveSpaceKey("999", exec, 5000, cache, []);
    expect(key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkSpacePermission
// ---------------------------------------------------------------------------

describe("checkSpacePermission", () => {
  it("allows any space when allowReadSpaces is empty", () => {
    expect(checkSpacePermission("TEAM", "read", {}).allowed).toBe(true);
    expect(checkSpacePermission("DOCS", "read", {}).allowed).toBe(true);
  });

  it("allows any space when allowWriteSpaces is empty", () => {
    expect(checkSpacePermission("TEAM", "write", {}).allowed).toBe(true);
  });

  it("allows a space in the allowReadSpaces list", () => {
    const config: ConfluenceConfig = { allowReadSpaces: ["TEAM", "DOCS"] };
    expect(checkSpacePermission("TEAM", "read", config).allowed).toBe(true);
    expect(checkSpacePermission("DOCS", "read", config).allowed).toBe(true);
  });

  it("blocks a space not in allowReadSpaces", () => {
    const config: ConfluenceConfig = { allowReadSpaces: ["TEAM"] };
    const r = checkSpacePermission("PRIVATE", "read", config);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("PRIVATE");
    expect(r.reason).toContain("allowReadSpaces");
    expect(r.reason).toContain("TEAM");
  });

  it("blocks a space not in allowWriteSpaces", () => {
    const config: ConfluenceConfig = { allowWriteSpaces: ["DRAFTS"] };
    const r = checkSpacePermission("TEAM", "write", config);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("allowWriteSpaces");
  });

  it("is case-insensitive", () => {
    const config: ConfluenceConfig = { allowReadSpaces: ["team"] };
    expect(checkSpacePermission("TEAM", "read", config).allowed).toBe(true);
    expect(checkSpacePermission("team", "read", config).allowed).toBe(true);
    expect(checkSpacePermission("Team", "read", config).allowed).toBe(true);
  });

  it("read and write lists are independent", () => {
    const config: ConfluenceConfig = {
      allowReadSpaces: ["DOCS"],
      allowWriteSpaces: ["DRAFTS"],
    };
    expect(checkSpacePermission("DOCS", "read", config).allowed).toBe(true);
    expect(checkSpacePermission("DOCS", "write", config).allowed).toBe(false);
    expect(checkSpacePermission("DRAFTS", "write", config).allowed).toBe(true);
    expect(checkSpacePermission("DRAFTS", "read", config).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceSpacePolicy
// ---------------------------------------------------------------------------

describe("enforceSpacePolicy — no space config", () => {
  it("allows everything when neither allowReadSpaces nor allowWriteSpaces is set", async () => {
    const exec = makeExecutor();
    const cache = new Map<string, string>();
    const r = await enforceSpacePolicy("delete", ["delete", "123"], {}, exec, 5000, cache, []);
    expect(r.allowed).toBe(true);
    expect(exec.calls).toHaveLength(0);
  });
});

describe("enforceSpacePolicy — agnostic commands", () => {
  const config: ConfluenceConfig = { allowReadSpaces: ["TEAM"], allowWriteSpaces: ["TEAM"] };

  it("spaces is always allowed", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy("spaces", ["spaces"], config, exec, 5000, new Map(), []);
    expect(r.allowed).toBe(true);
    expect(exec.calls).toHaveLength(0);
  });

  it("stats is always allowed", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy("stats", ["stats"], config, exec, 5000, new Map(), []);
    expect(r.allowed).toBe(true);
  });

  it("comment-delete is always allowed (see disclaimer)", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy("comment-delete", ["comment-delete", "998877"], config, exec, 5000, new Map(), []);
    expect(r.allowed).toBe(true);
    expect(exec.calls).toHaveLength(0);
  });
});

describe("enforceSpacePolicy — search", () => {
  const config: ConfluenceConfig = { allowReadSpaces: ["TEAM"] };

  it("allows search with permitted --space", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "search", ["search", "query", "--space", "TEAM"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks search with forbidden --space", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "search", ["search", "query", "--space", "SECRET"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("SECRET");
  });

  it("passes through search without --space when requireSpaceOnSearch is false", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "search", ["search", "query"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks search without --space when requireSpaceOnSearch is true", async () => {
    const cfg: ConfluenceConfig = { allowReadSpaces: ["TEAM"], requireSpaceOnSearch: true };
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "search", ["search", "query"], cfg, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("requireSpaceOnSearch");
    expect(r.reason).toContain("CQL");
  });

  it("requireSpaceOnSearch with a permitted --space is allowed", async () => {
    const cfg: ConfluenceConfig = { allowReadSpaces: ["TEAM"], requireSpaceOnSearch: true };
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "search", ["search", "query", "--space", "TEAM"], cfg, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });
});

describe("enforceSpacePolicy — find", () => {
  const config: ConfluenceConfig = { allowReadSpaces: ["TEAM"] };

  it("allows find with permitted --space", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "find", ["find", "My Page", "--space", "TEAM"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks find with forbidden --space", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "find", ["find", "My Page", "--space", "SECRET"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
  });

  it("allows find without --space (cannot restrict, fail open)", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "find", ["find", "My Page"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });
});

describe("enforceSpacePolicy — create (Tier 1, space in positional)", () => {
  const config: ConfluenceConfig = { allowWriteSpaces: ["DOCS"] };

  it("allows create in permitted space", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "create", ["create", "My Page", "DOCS"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
    expect(exec.calls).toHaveLength(0); // no info lookup needed
  });

  it("blocks create in forbidden space", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "create", ["create", "My Page", "SECRET"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("SECRET");
    expect(exec.calls).toHaveLength(0);
  });

  it("is case-insensitive on space key", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "create", ["create", "My Page", "docs"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });
});

describe("enforceSpacePolicy — read commands (Tier 2, page ID)", () => {
  const config: ConfluenceConfig = { allowReadSpaces: ["TEAM"] };

  it("allows read when page resolves to permitted space", async () => {
    const exec = makeInfoExecutor({ "123456789": "TEAM" });
    const r = await enforceSpacePolicy(
      "read", ["read", "123456789"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
    expect(exec.calls).toHaveLength(1);
  });

  it("blocks read when page resolves to forbidden space", async () => {
    const exec = makeInfoExecutor({ "123456789": "SECRET" });
    const r = await enforceSpacePolicy(
      "read", ["read", "123456789"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("SECRET");
  });

  it("allows read from URL with permitted space (no info call)", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "read",
      ["read", "https://example.atlassian.net/wiki/spaces/TEAM/pages/123"],
      config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
    expect(exec.calls).toHaveLength(0);
  });

  it("blocks read from URL with forbidden space (no info call)", async () => {
    const exec = makeExecutor();
    const r = await enforceSpacePolicy(
      "read",
      ["read", "https://example.atlassian.net/wiki/spaces/SECRET/pages/123"],
      config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(exec.calls).toHaveLength(0);
  });

  it("caches info lookups across enforce calls", async () => {
    const exec = makeInfoExecutor({ "123": "TEAM" });
    const cache = new Map<string, string>();
    await enforceSpacePolicy("read", ["read", "123"], config, exec, 5000, cache, []);
    await enforceSpacePolicy("read", ["read", "123"], config, exec, 5000, cache, []);
    // Only one info call despite two enforcements
    expect(exec.calls.filter(c => c.args.includes("info"))).toHaveLength(1);
  });
});

describe("enforceSpacePolicy — write commands (Tier 2, page ID)", () => {
  const config: ConfluenceConfig = { allowWriteSpaces: ["DRAFTS"] };

  it("allows update when page resolves to permitted write space", async () => {
    const exec = makeInfoExecutor({ "111": "DRAFTS" });
    const r = await enforceSpacePolicy(
      "update", ["update", "111", "--content", "new"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks delete when page resolves to forbidden write space", async () => {
    const exec = makeInfoExecutor({ "222": "READONLY" });
    const r = await enforceSpacePolicy(
      "delete", ["delete", "222", "--yes"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("READONLY");
  });

  it("create-child resolves parent page ID for space check", async () => {
    const exec = makeInfoExecutor({ "333": "DRAFTS" });
    const r = await enforceSpacePolicy(
      "create-child", ["create-child", "Title", "333"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });
});

describe("enforceSpacePolicy — copy-tree (two page IDs)", () => {
  const config: ConfluenceConfig = { allowWriteSpaces: ["TEAM"] };

  it("allows when both pages resolve to permitted space", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM", "222": "TEAM" });
    const r = await enforceSpacePolicy(
      "copy-tree", ["copy-tree", "111", "222"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks when source page is in forbidden space", async () => {
    const exec = makeInfoExecutor({ "111": "FORBIDDEN", "222": "TEAM" });
    const r = await enforceSpacePolicy(
      "copy-tree", ["copy-tree", "111", "222"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("FORBIDDEN");
  });

  it("blocks when target parent is in forbidden space", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM", "222": "FORBIDDEN" });
    const r = await enforceSpacePolicy(
      "copy-tree", ["copy-tree", "111", "222"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("FORBIDDEN");
  });
});

describe("enforceSpacePolicy — move (two page IDs)", () => {
  const config: ConfluenceConfig = { allowWriteSpaces: ["TEAM"] };

  it("allows when both pages are in permitted space", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM", "222": "TEAM" });
    const r = await enforceSpacePolicy(
      "move", ["move", "111", "222"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks when target parent is in forbidden space", async () => {
    const exec = makeInfoExecutor({ "111": "TEAM", "222": "PRIVATE" });
    const r = await enforceSpacePolicy(
      "move", ["move", "111", "222"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(false);
  });
});

describe("enforceSpacePolicy — fail open when space cannot be resolved", () => {
  it("allows command when info returns no Space: line", async () => {
    const exec = makeExecutor({ stdout: "Title: Something", exitCode: 0 });
    const config: ConfluenceConfig = { allowWriteSpaces: ["TEAM"] };
    const r = await enforceSpacePolicy(
      "delete", ["delete", "999"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });

  it("allows command when no first positional is extractable", async () => {
    const exec = makeExecutor();
    const config: ConfluenceConfig = { allowWriteSpaces: ["TEAM"] };
    const r = await enforceSpacePolicy(
      "delete", ["delete"], config, exec, 5000, new Map(), []
    );
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkPermission (existing tests, unchanged)
// ---------------------------------------------------------------------------

describe("checkPermission — no config (default: all allowed)", () => {
  it("allows read", () => {
    expect(checkPermission("read", {}, false).allowed).toBe(true);
  });

  it("allows search", () => {
    expect(checkPermission("search", {}, false).allowed).toBe(true);
  });

  it("allows create", () => {
    expect(checkPermission("create", {}, false).allowed).toBe(true);
  });

  it("allows create-child", () => {
    expect(checkPermission("create-child", {}, false).allowed).toBe(true);
  });

  it("allows update", () => {
    expect(checkPermission("update", {}, false).allowed).toBe(true);
  });

  it("allows delete", () => {
    expect(checkPermission("delete", {}, false).allowed).toBe(true);
  });

  it("allows profile list", () => {
    expect(checkPermission("profile list", {}, false).allowed).toBe(true);
  });

  it("allows profile use", () => {
    expect(checkPermission("profile use", {}, false).allowed).toBe(true);
  });

  it("allows stats", () => {
    expect(checkPermission("stats", {}, false).allowed).toBe(true);
  });
});

describe("checkPermission — denyCommands", () => {
  it("blocks exact match", () => {
    const r = checkPermission("delete", { denyCommands: "delete" }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("delete");
  });

  it("prefix 'create' blocks 'create-child' too", () => {
    expect(checkPermission("create", { denyCommands: "create" }, true).allowed).toBe(false);
    expect(checkPermission("create-child", { denyCommands: "create" }, true).allowed).toBe(false);
  });

  it("prefix 'create' does not block 'read'", () => {
    expect(checkPermission("read", { denyCommands: "create" }, true).allowed).toBe(true);
  });

  it("blocks prefix match — 'profile' covers all profile subcommands", () => {
    expect(checkPermission("profile list", { denyCommands: "profile" }, true).allowed).toBe(false);
    expect(checkPermission("profile use", { denyCommands: "profile" }, true).allowed).toBe(false);
    expect(checkPermission("profile add", { denyCommands: "profile" }, true).allowed).toBe(false);
  });

  it("exact two-token deny does not over-block sibling", () => {
    expect(checkPermission("profile use", { denyCommands: "profile list" }, true).allowed).toBe(true);
    expect(checkPermission("profile list", { denyCommands: "profile list" }, true).allowed).toBe(false);
  });

  it("accepts array of denyCommands", () => {
    const config = { denyCommands: ["create", "update", "delete"] };
    expect(checkPermission("create", config, true).allowed).toBe(false);
    expect(checkPermission("update", config, true).allowed).toBe(false);
    expect(checkPermission("delete", config, true).allowed).toBe(false);
    expect(checkPermission("read", config, true).allowed).toBe(true);
  });

  it("deny beats allow", () => {
    const config = { allowCommands: ["delete"], denyCommands: ["delete"] };
    expect(checkPermission("delete", config, true).allowed).toBe(false);
  });
});

describe("checkPermission — allowCommands", () => {
  it("allows command in allowlist", () => {
    const r = checkPermission("read", { allowCommands: ["read", "search"] }, true);
    expect(r.allowed).toBe(true);
  });

  it("blocks command not in allowlist", () => {
    const r = checkPermission("delete", { allowCommands: ["read", "search"] }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not in allowCommands");
    expect(r.reason).toContain("read");
  });

  it("prefix allowlist entry covers subcommands — 'create' allows 'create-child'", () => {
    const config = { allowCommands: "create" };
    expect(checkPermission("create", config, true).allowed).toBe(true);
    expect(checkPermission("create-child", config, true).allowed).toBe(true);
    expect(checkPermission("delete", config, true).allowed).toBe(false);
  });

  it("empty allowCommands (omitted) allows everything", () => {
    expect(checkPermission("delete", {}, true).allowed).toBe(true);
  });

  it("case-insensitive matching", () => {
    expect(checkPermission("Delete", { denyCommands: "delete" }, true).allowed).toBe(false);
    expect(checkPermission("Read", { allowCommands: "read" }, true).allowed).toBe(true);
  });

  it("'profile' prefix in allowlist covers both 'profile list' and 'profile use'", () => {
    const config = { allowCommands: ["read", "profile"] };
    expect(checkPermission("profile list", config, true).allowed).toBe(true);
    expect(checkPermission("profile use", config, true).allowed).toBe(true);
    expect(checkPermission("create", config, true).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler — no args
// ---------------------------------------------------------------------------

describe("handler — no args", () => {
  it("returns usage when called with empty args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage:");
    expect(result.output).toContain("confluence");
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Handler — command-level permission enforcement (existing)
// ---------------------------------------------------------------------------

describe("handler — command-level permission enforcement", () => {
  it("blocks denied command and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ denyCommands: ["delete", "update"] }, { executor: exec });
    const result = await handler(["delete", "123456789", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("delete");
    expect(exec.calls).toHaveLength(0);
  });

  it("blocks command not in allowlist and does not invoke executor", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ allowCommands: ["read", "search"] }, { executor: exec });
    const result = await handler(["create", "My Page", "SPACE"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows permitted command and invokes executor", async () => {
    const exec = makeExecutor({ stdout: "Page content here", exitCode: 0 });
    const handler = createHandler({ allowCommands: ["read", "search"] }, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Page content here");
    expect(exec.calls).toHaveLength(1);
  });

  it("allows all commands when no config provided", async () => {
    const exec = makeExecutor({ stdout: "done", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["delete", "123456789", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Handler — space-level enforcement via handler integration
// ---------------------------------------------------------------------------

describe("handler — space enforcement via allowWriteSpaces", () => {
  it("allows create in permitted space (Tier 1, no info call)", async () => {
    const exec = makeExecutor({ stdout: "created", exitCode: 0 });
    const handler = createHandler({ allowWriteSpaces: ["DOCS"] }, { executor: exec });
    const result = await handler(["create", "My Page", "DOCS", "--content", "hello"]);
    expect(result.exitCode).toBe(0);
    // Only the actual create call, no info lookup
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args[0]).toBe("create");
  });

  it("blocks create in forbidden space (Tier 1, no info call)", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ allowWriteSpaces: ["DOCS"] }, { executor: exec });
    const result = await handler(["create", "My Page", "SECRET", "--content", "hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("SECRET");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows update when page resolves to permitted space (Tier 2)", async () => {
    const exec = makeInfoExecutor({ "111": "DOCS" }, "updated");
    const handler = createHandler({ allowWriteSpaces: ["DOCS"] }, { executor: exec });
    const result = await handler(["update", "111", "--content", "new"]);
    expect(result.exitCode).toBe(0);
    // One info lookup + one update call
    expect(exec.calls).toHaveLength(2);
  });

  it("blocks update when page resolves to forbidden space (Tier 2)", async () => {
    const exec = makeInfoExecutor({ "111": "PRIVATE" });
    const handler = createHandler({ allowWriteSpaces: ["DOCS"] }, { executor: exec });
    const result = await handler(["update", "111", "--content", "new"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("PRIVATE");
    // info was called, update was not
    expect(exec.calls).toHaveLength(1);
  });
});

describe("handler — space enforcement via allowReadSpaces", () => {
  it("allows read from URL with permitted space (free, no info call)", async () => {
    const exec = makeExecutor({ stdout: "content", exitCode: 0 });
    const handler = createHandler({ allowReadSpaces: ["TEAM"] }, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/TEAM/pages/123",
    ]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args[0]).toBe("read");
  });

  it("blocks read from URL in forbidden space", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ allowReadSpaces: ["TEAM"] }, { executor: exec });
    const result = await handler([
      "read",
      "https://example.atlassian.net/wiki/spaces/SECRET/pages/123",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });

  it("no space enforcement when neither list is configured", async () => {
    const exec = makeExecutor({ stdout: "content", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.exitCode).toBe(0);
    // No info lookup at all
    expect(exec.calls).toHaveLength(1);
  });
});

describe("handler — requireSpaceOnSearch", () => {
  it("rejects search without --space when requireSpaceOnSearch is true", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { allowReadSpaces: ["TEAM"], requireSpaceOnSearch: true },
      { executor: exec }
    );
    const result = await handler(["search", "my query"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("requireSpaceOnSearch");
    expect(result.output).toContain("CQL");
    expect(exec.calls).toHaveLength(0);
  });

  it("allows search with --space when requireSpaceOnSearch is true", async () => {
    const exec = makeExecutor({ stdout: "results", exitCode: 0 });
    const handler = createHandler(
      { allowReadSpaces: ["TEAM"], requireSpaceOnSearch: true },
      { executor: exec }
    );
    const result = await handler(["search", "my query", "--space", "TEAM"]);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Handler — executor invocation (existing)
// ---------------------------------------------------------------------------

describe("handler — executor invocation", () => {
  it("passes args through to confluence unchanged", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["search", "API documentation", "--limit", "5"]);
    expect(exec.calls[0].cmd).toBe("confluence");
    expect(exec.calls[0].args).toEqual(["search", "API documentation", "--limit", "5"]);
  });

  it("passes exit code from executor through", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "page not found", exitCode: 1 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "999999"]);
    expect(result.exitCode).toBe(1);
  });

  it("combines stdout and stderr in output", async () => {
    const exec = makeExecutor({ stdout: "some output", stderr: "some warning", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.output).toContain("some output");
    expect(result.output).toContain("some warning");
  });

  it("returns (no output) when both stdout and stderr are empty", async () => {
    const exec = makeExecutor({ stdout: "", stderr: "", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["read", "123456789"]);
    expect(result.output).toBe("(no output)");
  });

  it("surfaces confluence not-found error clearly", async () => {
    const handler = createHandler({}, { executor: makeNotFoundExecutor() });
    const result = await handler(["read", "123456789"]);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Handler — --help passthrough (existing)
// ---------------------------------------------------------------------------

describe("handler — --help passthrough", () => {
  it("passes --help through even though no command path is extracted", async () => {
    const exec = makeExecutor({ stdout: "Usage: confluence ...", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    const result = await handler(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(exec.calls[0].args).toEqual(["--help"]);
  });

  it("passes subcommand --help through", async () => {
    const exec = makeExecutor({ stdout: "Usage: confluence read ...", exitCode: 0 });
    const handler = createHandler({}, { executor: exec });
    await handler(["read", "--help"]);
    expect(exec.calls[0].args).toEqual(["read", "--help"]);
  });
});

// ---------------------------------------------------------------------------
// Handler — profile injection (existing)
// ---------------------------------------------------------------------------

describe("handler — profile injection", () => {
  it("prepends --profile when configured and not in args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ profile: "production" }, { executor: exec });
    await handler(["search", "my term"]);
    // The actual search call (not the info lookup) has --profile prepended
    const searchCall = exec.calls.find(c => c.args.includes("search"));
    expect(searchCall?.args).toEqual(["--profile", "production", "search", "my term"]);
  });

  it("does not duplicate --profile if already in args", async () => {
    const exec = makeExecutor();
    const handler = createHandler({ profile: "production" }, { executor: exec });
    await handler(["--profile", "staging", "search", "my term"]);
    const profileCount = exec.calls[0].args.filter((a) => a === "--profile").length;
    expect(profileCount).toBe(1);
    expect(exec.calls[0].args[exec.calls[0].args.indexOf("--profile") + 1]).toBe("staging");
  });

  it("does not inject --profile when not configured", async () => {
    const exec = makeExecutor();
    const handler = createHandler({}, { executor: exec });
    await handler(["read", "123456789"]);
    expect(exec.calls[0].args).not.toContain("--profile");
  });

  it("profile is forwarded to info lookups", async () => {
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

  it("permission check sees command after --profile is skipped", async () => {
    const exec = makeExecutor();
    const handler = createHandler(
      { denyCommands: ["delete"], profile: "production" },
      { executor: exec }
    );
    const result = await handler(["--profile", "staging", "delete", "123"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(exec.calls).toHaveLength(0);
  });
});
