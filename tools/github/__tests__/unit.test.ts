import { describe, it, expect } from "vitest";
import { createHandler } from "../index.js";
import { createFakeGhClient } from "../../../test-utils/createFakeGhClient.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandler(config: Record<string, unknown> = {}) {
  const fake = createFakeGhClient();
  const handler = createHandler(config, { executor: fake.run });
  return { handler, fake };
}

// ---------------------------------------------------------------------------
// No-args usage
// ---------------------------------------------------------------------------

describe("no args", () => {
  it("returns usage text and exitCode 1", async () => {
    const { handler } = makeHandler();
    const result = await handler([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: github <subcommand>");
  });
});

// ---------------------------------------------------------------------------
// Access control — allowedCommands
// ---------------------------------------------------------------------------

describe("allowedCommands", () => {
  it("permits listed subcommands", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler(
      { allowedCommands: ["repo"] },
      { executor: fake.run }
    );

    const result = await handler(["repo", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("myorg/myrepo");
  });

  it("blocks subcommands not in the whitelist", async () => {
    const { handler } = makeHandler({ allowedCommands: ["repo"] });
    const result = await handler(["issue", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(result.output).toContain("issue");
  });

  it("shows permitted subcommands in denial message", async () => {
    const { handler } = makeHandler({ allowedCommands: ["pr", "issue"] });
    const result = await handler(["repo", "list"]);
    expect(result.output).toContain("pr");
    expect(result.output).toContain("issue");
  });
});

// ---------------------------------------------------------------------------
// Access control — deniedCommands
// ---------------------------------------------------------------------------

describe("deniedCommands", () => {
  it("blocks listed subcommands even when no allowedCommands set", async () => {
    const { handler } = makeHandler({ deniedCommands: ["repo"] });
    const result = await handler(["repo", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("deny beats allow when both are set", async () => {
    const { handler } = makeHandler({
      allowedCommands: ["repo", "issue"],
      deniedCommands: ["repo"],
    });
    const result = await handler(["repo", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("allows non-denied subcommands when deniedCommands is set", async () => {
    const fake = createFakeGhClient();
    fake.register(["issue", "list"], { stdout: "issue #1\nissue #2", exitCode: 0 });

    const handler = createHandler(
      { deniedCommands: ["repo"] },
      { executor: fake.run }
    );

    const result = await handler(["issue", "list"]);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hard-blocked operations
// ---------------------------------------------------------------------------

describe("hard-blocked operations", () => {
  it("blocks repo delete regardless of allowedCommands", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "delete", "myorg/myrepo"], { stdout: "deleted", exitCode: 0 });

    const handler = createHandler({ allowedCommands: ["repo"] }, { executor: fake.run });
    const result = await handler(["repo", "delete", "myorg/myrepo"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("permanently blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("blocks repo delete even with no config restrictions", async () => {
    const fake = createFakeGhClient();
    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["repo", "delete"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("permanently blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("does not block other repo subcommands", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["repo", "list"]);

    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it("blocks api by default (not in ALL_COMMANDS)", async () => {
    const fake = createFakeGhClient();
    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["api", "repos/myorg/myrepo"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
    expect(fake.calls).toHaveLength(0);
  });

  it("allows api when explicitly opted in via allowedCommands", async () => {
    const fake = createFakeGhClient();
    fake.register(["api", "repos/myorg/myrepo"], { stdout: '{"name":"myrepo"}', exitCode: 0 });

    const handler = createHandler({ allowedCommands: ["api"] }, { executor: fake.run });
    const result = await handler(["api", "repos/myorg/myrepo"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("myrepo");
    expect(fake.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Successful gh execution
// ---------------------------------------------------------------------------

describe("successful execution", () => {
  it("forwards args to the executor", async () => {
    const fake = createFakeGhClient();
    fake.register(["pr", "list", "--repo", "myorg/myrepo"], {
      stdout: "PR #1: Add feature",
      exitCode: 0,
    });

    const handler = createHandler({}, { executor: fake.run });
    await handler(["pr", "list", "--repo", "myorg/myrepo"]);

    expect(fake.calls[0]).toEqual(["pr", "list", "--repo", "myorg/myrepo"]);
  });

  it("returns stdout on success", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "view", "myorg/myrepo"], {
      stdout: "myorg/myrepo — A great repo",
      exitCode: 0,
    });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["repo", "view", "myorg/myrepo"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("myorg/myrepo — A great repo");
  });

  it("returns '(no output)' when stdout is empty on success", async () => {
    const fake = createFakeGhClient();
    fake.register(["issue", "close", "42"], { stdout: "", exitCode: 0 });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["issue", "close", "42"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("(no output)");
  });
});

// ---------------------------------------------------------------------------
// Token authentication
// ---------------------------------------------------------------------------

describe("token authentication", () => {
  it("passes token to the executor when config.token is set", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler(
      { token: "ghp_testtoken123" },
      { executor: fake.run }
    );
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBe("ghp_testtoken123");
  });

  it("passes PAT (github_pat_…) to the executor unchanged", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler(
      { token: "github_pat_11AABBCC_longfinegrainedsecret" },
      { executor: fake.run }
    );
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBe("github_pat_11AABBCC_longfinegrainedsecret");
  });

  it("passes undefined to the executor when no token is configured", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler({}, { executor: fake.run });
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBeUndefined();
  });

  it("trims whitespace from the token value", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler(
      { token: "  ghp_trimmed  " },
      { executor: fake.run }
    );
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBe("ghp_trimmed");
  });

  it("treats an empty token string as no token", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler({ token: "" }, { executor: fake.run });
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBeUndefined();
  });

  it("treats a whitespace-only token string as no token", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "list"], { stdout: "myorg/myrepo", exitCode: 0 });

    const handler = createHandler({ token: "   " }, { executor: fake.run });
    await handler(["repo", "list"]);

    expect(fake.tokens[0]).toBeUndefined();
  });

  it("token does not affect access-control checks", async () => {
    const { handler } = makeHandler({ token: "ghp_sometoken", allowedCommands: ["issue"] });
    const result = await handler(["repo", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Permission denied");
  });

  it("token does not affect hard-blocked operations", async () => {
    const fake = createFakeGhClient();
    const handler = createHandler({ token: "ghp_sometoken" }, { executor: fake.run });
    const result = await handler(["repo", "delete", "myorg/myrepo"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("permanently blocked");
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failed gh execution
// ---------------------------------------------------------------------------

describe("failed execution", () => {
  it("returns exitCode from gh on failure", async () => {
    const fake = createFakeGhClient();
    fake.register(["repo", "view", "no/such-repo"], {
      stderr: "repository not found",
      exitCode: 1,
    });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["repo", "view", "no/such-repo"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("repository not found");
  });

  it("combines stdout and stderr on failure", async () => {
    const fake = createFakeGhClient();
    fake.register(["pr", "merge", "1"], {
      stdout: "partial output",
      stderr: "merge failed",
      exitCode: 1,
    });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["pr", "merge", "1"]);

    expect(result.output).toContain("partial output");
    expect(result.output).toContain("merge failed");
  });

  it("returns a fallback message when both streams are empty on failure", async () => {
    const fake = createFakeGhClient();
    fake.register(["release", "view", "v0.0.0"], { stdout: "", stderr: "", exitCode: 2 });

    const handler = createHandler({}, { executor: fake.run });
    const result = await handler(["release", "view", "v0.0.0"]);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("gh exited with code 2");
  });
});
