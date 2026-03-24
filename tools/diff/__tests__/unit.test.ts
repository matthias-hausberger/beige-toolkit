import { assertEquals, assertMatch } from "jsr:@std/assert";
import { diffTool, diffLines, formatDiff, countDiffStats } from "../index.ts";

const config = { maxFileSize: 10485760, contextLines: 3 };

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
  const result = await diffTool([], config);
  assertMatch(result, /Diff Tool/);
  assertMatch(result, /COMMANDS/);
});

Deno.test("help - shows help with --help", async () => {
  const result = await diffTool(["--help"], config);
  assertMatch(result, /Diff Tool/);
});

// ============ DIFF LINES ALGORITHM TESTS ============
Deno.test("diffLines - identical content", () => {
  const diff = diffLines(["a", "b", "c"], ["a", "b", "c"]);
  assertEquals(diff.length, 3);
  assertEquals(diff.every(d => d.type === "unchanged"), true);
});

Deno.test("diffLines - single addition", () => {
  const diff = diffLines(["a"], ["a", "b"]);
  assertEquals(diff.length, 2);
  assertEquals(diff[0].type, "unchanged");
  assertEquals(diff[1].type, "added");
  assertEquals(diff[1].content, "b");
});

Deno.test("diffLines - single removal", () => {
  const diff = diffLines(["a", "b"], ["a"]);
  assertEquals(diff.length, 2);
  assertEquals(diff[0].type, "unchanged");
  assertEquals(diff[1].type, "removed");
  assertEquals(diff[1].content, "b");
});

Deno.test("diffLines - middle change", () => {
  const diff = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  // LCS finds a and c unchanged, b removed, x added = 4 items
  assertEquals(diff.length, 4);
  assertEquals(diff[0].type, "unchanged");
  // The removed and added can be in different orders depending on LCS backtrack
  const removed = diff.find(d => d.type === "removed");
  const added = diff.find(d => d.type === "added");
  assertEquals(removed?.content, "b");
  assertEquals(added?.content, "x");
});

Deno.test("diffLines - complete change", () => {
  const diff = diffLines(["a", "b"], ["x", "y"]);
  assertEquals(diff.length, 4);
  assertEquals(diff.filter(d => d.type === "removed").length, 2);
  assertEquals(diff.filter(d => d.type === "added").length, 2);
});

// ============ COUNT STATS TESTS ============
Deno.test("countDiffStats - counts additions", () => {
  const diff = diffLines(["a"], ["a", "b", "c"]);
  const stats = countDiffStats(diff);
  assertEquals(stats.added, 2);
  assertEquals(stats.removed, 0);
  assertEquals(stats.unchanged, 1);
});

Deno.test("countDiffStats - counts removals", () => {
  const diff = diffLines(["a", "b", "c"], ["a"]);
  const stats = countDiffStats(diff);
  assertEquals(stats.added, 0);
  assertEquals(stats.removed, 2);
  assertEquals(stats.unchanged, 1);
});

Deno.test("countDiffStats - counts mixed", () => {
  const diff = diffLines(["a", "b", "c"], ["a", "x", "y"]);
  const stats = countDiffStats(diff);
  assertEquals(stats.added, 2);
  assertEquals(stats.removed, 2);
  assertEquals(stats.unchanged, 1);
});

// ============ TEXT COMMAND TESTS ============
Deno.test("text - identical text", async () => {
  const result = await diffTool(["text", "hello", "hello"], config);
  assertMatch(result, /0 additions/);
  assertMatch(result, /0 deletions/);
});

Deno.test("text - with differences", async () => {
  const result = await diffTool(["text", "hello world", "hello there"], config);
  assertMatch(result, /\+ hello there/);
  assertMatch(result, /- hello world/);
});

Deno.test("text - JSON format", async () => {
  const result = await diffTool(["text", "a", "b", "-f", "json"], config);
  const parsed = JSON.parse(result);
  assertEquals(parsed.stats.added, 1);
  assertEquals(parsed.stats.removed, 1);
});

// ============ JSON COMMAND TESTS ============
Deno.test("json - identical objects", async () => {
  const result = await diffTool(["json", '{"a":1}', '{"a":1}'], config);
  assertEquals(result, "JSON objects are equal");
});

Deno.test("json - different values", async () => {
  const result = await diffTool(["json", '{"a":1}', '{"a":2}'], config);
  assertMatch(result, /~/);  // changed marker
  assertMatch(result, /1.*2/);
});

Deno.test("json - added key", async () => {
  const result = await diffTool(["json", '{"a":1}', '{"a":1,"b":2}'], config);
  assertMatch(result, /\+/);  // added marker
  assertMatch(result, /b/);
});

Deno.test("json - removed key", async () => {
  const result = await diffTool(["json", '{"a":1,"b":2}', '{"a":1}'], config);
  assertMatch(result, /-/);  // removed marker
  assertMatch(result, /b/);
});

Deno.test("json - nested difference", async () => {
  const result = await diffTool(
    ["json", '{"outer":{"inner":1}}', '{"outer":{"inner":2}}'],
    config
  );
  assertMatch(result, /outer\.inner/);
});

Deno.test("json - array difference", async () => {
  const result = await diffTool(
    ["json", '[1,2,3]', '[1,2,4]'],
    config
  );
  assertMatch(result, /\[2\]/);
});

Deno.test("json - JSON format output", async () => {
  const result = await diffTool(["json", '{"a":1}', '{"a":2}', "-f", "json"], config);
  const parsed = JSON.parse(result);
  assertEquals(parsed.equal, false);
  assertEquals(parsed.differences.length, 1);
});

Deno.test("json - invalid JSON throws", () => {
  return expectReject(diffTool(["json", "not json", "{}"], config));
});

// ============ LINES COMMAND TESTS ============
Deno.test("lines - identical sets", async () => {
  const result = await diffTool(["lines", "a\nb\nc", "c\nb\na"], config);
  assertMatch(result, /Common: 3/);
});

Deno.test("lines - different sets", async () => {
  const result = await diffTool(["lines", "a\nb\nc", "b\nc\nd"], config);
  assertMatch(result, /Only in first/);
  assertMatch(result, /Only in second/);
});

Deno.test("lines - JSON format", async () => {
  const result = await diffTool(["lines", "a\nb", "b\nc", "-f", "json"], config);
  const parsed = JSON.parse(result);
  assertEquals(parsed.stats.onlyInFirst, 1);
  assertEquals(parsed.stats.onlyInSecond, 1);
  assertEquals(parsed.stats.common, 1);
});

// ============ FILES COMMAND TESTS ============
Deno.test("files - requires two files", () => {
  return expectReject(diffTool(["files", "one"], config));
});

// ============ DIRS COMMAND TESTS ============
Deno.test("dirs - requires two directories", () => {
  return expectReject(diffTool(["dirs", "one"], config));
});

// ============ ERROR HANDLING TESTS ============
Deno.test("text - requires two arguments", () => {
  return expectReject(diffTool(["text", "one"], config));
});

Deno.test("json - requires two arguments", () => {
  return expectReject(diffTool(["json", "{}"], config));
});

Deno.test("lines - requires two arguments", () => {
  return expectReject(diffTool(["lines", "a"], config));
});

Deno.test("unknown command throws", () => {
  return expectReject(diffTool(["unknown"], config));
});

// ============ FORMAT DIFF TESTS ============
Deno.test("formatDiff - includes context lines", () => {
  const diff = diffLines(
    ["1", "2", "3", "4", "5", "6", "7"],
    ["1", "2", "3", "X", "5", "6", "7"]
  );
  const formatted = formatDiff(diff, 2, true);
  assertMatch(formatted, /@@/);
});

// ============ ACTUAL FILE COMPARISON TESTS ============
Deno.test("files - compare actual files", async () => {
  // Create temp files
  const file1 = "/tmp/diff_test_1.txt";
  const file2 = "/tmp/diff_test_2.txt";
  
  await Deno.writeTextFile(file1, "hello\nworld");
  await Deno.writeTextFile(file2, "hello\nthere");
  
  try {
    const result = await diffTool(["files", file1, file2], config);
    assertMatch(result, /world/);
    assertMatch(result, /there/);
  } finally {
    await Deno.remove(file1);
    await Deno.remove(file2);
  }
});

Deno.test("files - identical files", async () => {
  const file1 = "/tmp/diff_same_1.txt";
  const file2 = "/tmp/diff_same_2.txt";
  
  await Deno.writeTextFile(file1, "same content");
  await Deno.writeTextFile(file2, "same content");
  
  try {
    const result = await diffTool(["files", file1, file2], config);
    assertMatch(result, /0 additions/);
    assertMatch(result, /0 deletions/);
  } finally {
    await Deno.remove(file1);
    await Deno.remove(file2);
  }
});

// ============ DIRECTORY COMPARISON TESTS ============
Deno.test("dirs - compare directories", async () => {
  const dir1 = "/tmp/diff_dir1";
  const dir2 = "/tmp/diff_dir2";
  
  await Deno.mkdir(dir1, { recursive: true });
  await Deno.mkdir(dir2, { recursive: true });
  
  await Deno.writeTextFile(`${dir1}/same.txt`, "same");
  await Deno.writeTextFile(`${dir2}/same.txt`, "same");
  await Deno.writeTextFile(`${dir1}/only1.txt`, "only in dir1");
  await Deno.writeTextFile(`${dir2}/only2.txt`, "only in dir2");
  
  try {
    const result = await diffTool(["dirs", dir1, dir2], config);
    assertMatch(result, /only1.txt/);
    assertMatch(result, /only2.txt/);
  } finally {
    await Deno.remove(dir1, { recursive: true });
    await Deno.remove(dir2, { recursive: true });
  }
});

Deno.test("dirs - JSON format", async () => {
  const dir1 = "/tmp/diff_json_dir1";
  const dir2 = "/tmp/diff_json_dir2";
  
  await Deno.mkdir(dir1, { recursive: true });
  await Deno.mkdir(dir2, { recursive: true });
  
  await Deno.writeTextFile(`${dir1}/a.txt`, "a");
  await Deno.writeTextFile(`${dir2}/b.txt`, "b");
  
  try {
    const result = await diffTool(["dirs", dir1, dir2, "-f", "json"], config);
    const parsed = JSON.parse(result);
    assertEquals(parsed.onlyInDir1.includes("a.txt"), true);
    assertEquals(parsed.onlyInDir2.includes("b.txt"), true);
  } finally {
    await Deno.remove(dir1, { recursive: true });
    await Deno.remove(dir2, { recursive: true });
  }
});
