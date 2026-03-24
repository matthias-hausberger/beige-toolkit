import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { spawn } from "child_process";

// Mock process list for testing
function createMockProcessList() {
  return [
    { pid: 1, ppid: 0, name: "init", user: "root", cpu: 0.0, mem: 0.1 },
    { pid: 100, ppid: 1, name: "node", user: "app", cpu: 5.2, mem: 2.5 },
    { pid: 101, ppid: 100, name: "node", user: "app", cpu: 10.5, mem: 3.0 },
    { pid: 200, ppid: 1, name: "chrome", user: "user", cpu: 25.3, mem: 15.0 },
    { pid: 201, ppid: 200, name: "chrome", user: "user", cpu: 15.2, mem: 8.5 },
    { pid: 300, ppid: 1, name: "python", user: "user", cpu: 2.1, mem: 1.5 },
  ];
}

Deno.test("process tool - list command returns processes", async () => {
  const result = await runTool("list", { limit: 5 });
  assertEquals(typeof result, "string");
  // Should have header
  assertEquals(result.includes("PID"), true);
});

Deno.test("process tool - list with filter", async () => {
  const result = await runTool("list", { filter: "node", format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);
  // All results should contain 'node'
  for (const proc of parsed) {
    const hasNode =
      proc.name.toLowerCase().includes("node") ||
      (proc.cmd && proc.cmd.toLowerCase().includes("node"));
    assertEquals(hasNode, true);
  }
});

Deno.test("process tool - list with user filter", async () => {
  const result = await runTool("list", { user: "root", format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);
  for (const proc of parsed) {
    assertEquals(proc.user, "root");
  }
});

Deno.test("process tool - list with sort by CPU", async () => {
  const result = await runTool("list", { sort: "cpu", limit: 10, format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);

  // Verify descending order
  for (let i = 1; i < parsed.length; i++) {
    assertEquals(parsed[i - 1].cpu >= parsed[i].cpu, true);
  }
});

Deno.test("process tool - list with sort by memory", async () => {
  const result = await runTool("list", { sort: "mem", limit: 10, format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);

  // Verify descending order
  for (let i = 1; i < parsed.length; i++) {
    assertEquals(parsed[i - 1].mem >= parsed[i].mem, true);
  }
});

Deno.test("process tool - list with limit", async () => {
  const result = await runTool("list", { limit: 5, format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed.length <= 5, true);
});

Deno.test("process tool - find by name", async () => {
  const result = await runTool("find", { name: "node", format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);

  for (const proc of parsed) {
    assertEquals(proc.name.toLowerCase().includes("node"), true);
  }
});

Deno.test("process tool - find with exact match", async () => {
  const result = await runTool("find", { name: "node", exact: true, format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);

  for (const proc of parsed) {
    assertEquals(proc.name.toLowerCase(), "node");
  }
});

Deno.test("process tool - find by command pattern", async () => {
  const result = await runTool("find", { cmd: "webpack", format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);
});

Deno.test("process tool - find with limit", async () => {
  const result = await runTool("find", { limit: 3, format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed.length <= 3, true);
});

Deno.test("process tool - kill with invalid PID throws error", async () => {
  await assertRejects(
    async () => {
      await runTool("kill", { pid: 999999999 });
    },
    Error,
    "not found"
  );
});

Deno.test("process tool - kill with force flag uses SIGKILL", async () => {
  // This test creates a sleep process and kills it
  const child = spawn("sleep", ["100"]);
  const pid = child.pid!;

  // Give it a moment to start
  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const result = await runTool("kill", { pid, force: true });
    assertEquals(result.includes("SIGKILL"), true);
  } finally {
    child.kill();
  }
});

Deno.test("process tool - kill with signal option", async () => {
  const child = spawn("sleep", ["100"]);
  const pid = child.pid!;

  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const result = await runTool("kill", { pid, signal: "SIGTERM" });
    assertEquals(result.includes("SIGTERM"), true);
  } finally {
    child.kill();
  }
});

Deno.test("process tool - tree command returns hierarchy", async () => {
  const result = await runTool("tree", { pid: 1 });
  assertEquals(typeof result, "string");
  // Should contain the root PID
  assertEquals(result.includes("1"), true);
});

Deno.test("process tool - top by CPU", async () => {
  const result = await runTool("top", { by: "cpu", limit: 5 });
  assertEquals(typeof result, "string");
  assertEquals(result.includes("CPU"), true);
});

Deno.test("process tool - top by memory", async () => {
  const result = await runTool("top", { by: "mem", limit: 5 });
  assertEquals(typeof result, "string");
  assertEquals(result.includes("MEM"), true);
});

Deno.test("process tool - monitor for short duration", async () => {
  const result = await runTool("monitor", { duration: 1, interval: 1 });
  assertEquals(typeof result, "string");
  assertEquals(result.includes("Time"), true);
});

Deno.test("process tool - ps alias works", async () => {
  const result = await runTool("ps", { limit: 5 });
  assertEquals(typeof result, "string");
  assertEquals(result.includes("PID"), true);
});

Deno.test("process tool - table format is default", async () => {
  const result = await runTool("list", { limit: 5 });
  assertEquals(typeof result, "string");
  // Table format should have separator line
  assertEquals(result.includes("─"), true);
});

Deno.test("process tool - JSON format is valid", async () => {
  const result = await runTool("list", { format: "json", limit: 5 });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);

  // Each process should have required fields
  for (const proc of parsed) {
    assertEquals(typeof proc.pid, "number");
    assertEquals(typeof proc.ppid, "number");
    assertEquals(typeof proc.name, "string");
  }
});

Deno.test("process tool - find returns empty array for non-existent process", async () => {
  const result = await runTool("find", { name: "xyzzy12345nonexistent", format: "json" });
  const parsed = JSON.parse(result);
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed.length, 0);
});

Deno.test("process tool - list with invalid sort field uses default", async () => {
  // Invalid sort should not crash
  const result = await runTool("list", { sort: "invalid" as unknown as "pid" });
  assertEquals(typeof result, "string");
});

Deno.test("process tool - monitor with specific metrics", async () => {
  const result = await runTool("monitor", {
    duration: 1,
    interval: 1,
    metrics: ["cpu", "mem"],
  });
  assertEquals(typeof result, "string");
  assertEquals(result.includes("CPU"), true);
  assertEquals(result.includes("MEM"), true);
});

// Helper function to run the tool
async function runTool(command: string, args: Record<string, unknown>): Promise<string> {
  const toolPath = new URL("../index.ts", import.meta.url).pathname;

  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      toolPath,
      command,
      ...Object.entries(args).flatMap(([key, value]) => {
        if (value === undefined || value === null) return [];
        if (typeof value === "boolean") {
          return value ? [`--${key}` : [];
        }
        if (Array.isArray(value)) {
          return [`--${key}`, JSON.stringify(value)];
        }
        return [`--${key}`, String(value)];
      }),
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { stdout, stderr, success } = await cmd.output();

  if (!success) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(error);
  }

  return new TextDecoder().decode(stdout);
}

// Integration test - actually run a process and verify we can find it
Deno.test("process tool integration - find spawned process", async () => {
  // Spawn a unique process
  const child = spawn("sleep", ["100"]);
  const pid = child.pid!;

  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    // Find it by name
    const result = await runTool("find", { name: "sleep", format: "json" });
    const parsed = JSON.parse(result);
    assertEquals(Array.isArray(parsed), true);

    // Should find at least one sleep process
    const found = parsed.some((p: { pid: number }) => p.pid === pid);
    assertEquals(found, true);
  } finally {
    child.kill();
  }
});

Deno.test("process tool integration - kill spawned process", async () => {
  const child = spawn("sleep", ["100"]);
  const pid = child.pid!;

  await new Promise((resolve) => setTimeout(resolve, 100));

  // Kill it
  const result = await runTool("kill", { pid, signal: "SIGTERM" });
  assertEquals(result.includes("SIGTERM"), true);
  assertEquals(result.includes(String(pid)), true);

  // Verify it's gone
  await new Promise((resolve) => setTimeout(resolve, 100));
  const findResult = await runTool("find", { name: "sleep", format: "json" });
  const parsed = JSON.parse(findResult);
  const stillExists = parsed.some((p: { pid: number }) => p.pid === pid);
  assertEquals(stillExists, false);
});

console.log("All tests defined");
