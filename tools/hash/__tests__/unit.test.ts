import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert";
import { hashTool, ALGORITHMS } from "../index.ts";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

const config = { defaultAlgorithm: "sha256" };

// Helper for async rejection testing
async function expectReject(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected promise to reject, but it resolved");
  } catch {
    // Expected
  }
}

// ============ HELP TESTS ============
Deno.test("help - shows help with no args", async () => {
  const result = await hashTool([], config);
  assertMatch(result, /Hash Tool/);
  assertMatch(result, /COMMANDS/);
});

Deno.test("help - shows help with --help", async () => {
  const result = await hashTool(["--help"], config);
  assertMatch(result, /Hash Tool/);
});

// ============ DIGEST TESTS ============
Deno.test("digest - hashes string with default algorithm", async () => {
  const result = await hashTool(["digest", "hello"], config);
  assertEquals(
    result,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
});

Deno.test("digest - hashes with SHA-512", async () => {
  const result = await hashTool(["digest", "hello", "-a", "sha512"], config);
  assertEquals(result.length, 128); // 512 bits = 128 hex chars
});

Deno.test("digest - hashes with MD5", async () => {
  const result = await hashTool(["digest", "hello", "-a", "md5"], config);
  assertEquals(result.length, 32); // 128 bits = 32 hex chars
});

Deno.test("digest - outputs base64 encoding", async () => {
  const result = await hashTool(["digest", "hello", "-e", "base64"], config);
  assertMatch(result, /^[A-Za-z0-9+/]+=*$/);
});

Deno.test("digest - outputs base64url encoding", async () => {
  const result = await hashTool(["digest", "hello", "-e", "base64url"], config);
  assertEquals(result.includes("+"), false);
  assertEquals(result.includes("/"), false);
  assertEquals(result.includes("="), false);
});

Deno.test("digest - handles multi-word input", async () => {
  const result = await hashTool(["digest", "hello", "world"], config);
  assertEquals(result.length, 64); // SHA-256 hex
});

Deno.test("digest - rejects invalid algorithm", async () => {
  await expectReject(hashTool(["digest", "test", "-a", "invalid"], config));
});

// ============ HMAC TESTS ============
Deno.test("hmac - generates HMAC with default algorithm", async () => {
  const result = await hashTool(["hmac", "message", "secret-key"], config);
  assertEquals(result.length, 64); // SHA-256 hex
});

Deno.test("hmac - generates HMAC with SHA-512", async () => {
  const result = await hashTool(
    ["hmac", "message", "secret-key", "-a", "sha512"],
    config
  );
  assertEquals(result.length, 128);
});

Deno.test("hmac - outputs base64 encoding", async () => {
  const result = await hashTool(["hmac", "message", "key", "-e", "base64"], config);
  assertMatch(result, /^[A-Za-z0-9+/]+=*$/);
});

Deno.test("hmac - requires key", async () => {
  await expectReject(hashTool(["hmac", "message"], config));
});

// ============ FILE TESTS ============
const testFile = "/tmp/hash-test-file.txt";

Deno.test("file - hashes file with default algorithm", async () => {
  writeFileSync(testFile, "test content\n");
  try {
    const result = await hashTool(["file", testFile], config);
    assertEquals(result.length, 64); // SHA-256 hex
  } finally {
    if (existsSync(testFile)) unlinkSync(testFile);
  }
});

Deno.test("file - hashes file with MD5", async () => {
  writeFileSync(testFile, "test content\n");
  try {
    const result = await hashTool(["file", testFile, "-a", "md5"], config);
    assertEquals(result.length, 32);
  } finally {
    if (existsSync(testFile)) unlinkSync(testFile);
  }
});

Deno.test("file - outputs base64 encoding", async () => {
  writeFileSync(testFile, "test content\n");
  try {
    const result = await hashTool(["file", testFile, "-e", "base64"], config);
    assertMatch(result, /^[A-Za-z0-9+/]+=*$/);
  } finally {
    if (existsSync(testFile)) unlinkSync(testFile);
  }
});

// ============ COMPARE TESTS ============
Deno.test("compare - returns match: true for equal strings", async () => {
  const result = await hashTool(["compare", "hello", "hello"], config);
  assertEquals(JSON.parse(result), { match: true });
});

Deno.test("compare - returns match: false for different strings", async () => {
  const result = await hashTool(["compare", "hello", "world"], config);
  assertEquals(JSON.parse(result), { match: false });
});

Deno.test("compare - compares hashes", async () => {
  const hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const result = await hashTool(["compare", hash, hash], config);
  assertEquals(JSON.parse(result), { match: true });
});

// ============ UUID TESTS ============
Deno.test("uuid - generates valid UUID v4", async () => {
  const result = await hashTool(["uuid"], config);
  assertMatch(
    result,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

Deno.test("uuid - generates unique UUIDs", async () => {
  const uuid1 = await hashTool(["uuid"], config);
  const uuid2 = await hashTool(["uuid"], config);
  assertEquals(uuid1 === uuid2, false);
});

// ============ RANDOM TESTS ============
Deno.test("random - generates random bytes (default 32 bytes)", async () => {
  const result = await hashTool(["random"], config);
  assertEquals(result.length, 64); // 32 bytes = 64 hex chars
});

Deno.test("random - generates specified length", async () => {
  const result = await hashTool(["random", "16"], config);
  assertEquals(result.length, 32); // 16 bytes = 32 hex chars
});

Deno.test("random - outputs base64 encoding", async () => {
  const result = await hashTool(["random", "32", "-e", "base64"], config);
  assertMatch(result, /^[A-Za-z0-9+/]+=*$/);
});

Deno.test("random - outputs base64url encoding", async () => {
  const result = await hashTool(["random", "32", "-e", "base64url"], config);
  assertEquals(result.includes("+"), false);
  assertEquals(result.includes("/"), false);
});

Deno.test("random - rejects invalid length", async () => {
  await expectReject(hashTool(["random", "0"], config));
});

// ============ ENCODE TESTS ============
Deno.test("encode - encodes to base64", async () => {
  const result = await hashTool(["encode", "hello", "-f", "base64"], config);
  assertEquals(result, "aGVsbG8=");
});

Deno.test("encode - encodes to base64url", async () => {
  const result = await hashTool(["encode", "hello", "-f", "base64url"], config);
  assertEquals(result, "aGVsbG8");
});

Deno.test("encode - encodes to hex", async () => {
  const result = await hashTool(["encode", "AB", "-f", "hex"], config);
  assertEquals(result, "4142");
});

Deno.test("encode - encodes to URL", async () => {
  const result = await hashTool(["encode", "hello world", "-f", "url"], config);
  assertEquals(result, "hello%20world");
});

Deno.test("encode - encodes to HTML entities", async () => {
  const result = await hashTool(["encode", "<script>", "-f", "html"], config);
  assertEquals(result, "&lt;script&gt;");
});

Deno.test("encode - escapes quotes in HTML", async () => {
  const result = await hashTool(["encode", '"test"', "-f", "html"], config);
  assertEquals(result, "&quot;test&quot;");
});

// ============ DECODE TESTS ============
Deno.test("decode - decodes from base64", async () => {
  const result = await hashTool(["decode", "aGVsbG8=", "-f", "base64"], config);
  assertEquals(result, "hello");
});

Deno.test("decode - decodes from base64url", async () => {
  const result = await hashTool(["decode", "aGVsbG8", "-f", "base64url"], config);
  assertEquals(result, "hello");
});

Deno.test("decode - decodes from hex", async () => {
  const result = await hashTool(["decode", "4142", "-f", "hex"], config);
  assertEquals(result, "AB");
});

Deno.test("decode - decodes from URL", async () => {
  const result = await hashTool(["decode", "hello%20world", "-f", "url"], config);
  assertEquals(result, "hello world");
});

Deno.test("decode - decodes from HTML entities", async () => {
  const result = await hashTool(["decode", "&lt;script&gt;", "-f", "html"], config);
  assertEquals(result, "<script>");
});

// ============ ALGORITHMS TESTS ============
Deno.test("algorithms - lists all algorithms", async () => {
  const result = await hashTool(["algorithms"], config);
  const parsed = JSON.parse(result);
  assertEquals(parsed.algorithms.includes("sha256"), true);
  assertEquals(parsed.algorithms.includes("sha512"), true);
  assertEquals(parsed.algorithms.includes("md5"), true);
});

// ============ CONFIG TESTS ============
Deno.test("config - respects defaultAlgorithm", async () => {
  const customConfig = { defaultAlgorithm: "md5" };
  const result = await hashTool(["digest", "hello"], customConfig);
  assertEquals(result.length, 32); // MD5 = 32 hex chars
});

Deno.test("config - respects allowedAlgorithms", async () => {
  const restrictedConfig = {
    allowedAlgorithms: ["sha256"],
  };
  await expectReject(
    hashTool(["digest", "test", "-a", "md5"], restrictedConfig)
  );
});
