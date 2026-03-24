#!/usr/bin/env node
/**
 * Process Tool - List, monitor, and manage processes
 *
 * Provides process management capabilities similar to ps, kill, and top.
 * Designed to be safe for AI agents with configurable permissions.
 */

import { Tool, defineTool, Schema } from "tool-lib";
import { execSync, spawn } from "child_process";

interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd?: string;
  user?: string;
  cpu?: number;
  mem?: number;
  state?: string;
  startTime?: string;
  elapsed?: string;
}

interface ProcessListOptions {
  filter?: string;
  user?: string;
  name?: string;
  sort?: "pid" | "cpu" | "mem" | "name" | "time";
  limit?: number;
  tree?: boolean;
  format?: "json" | "table";
}

interface ProcessKillOptions {
  pid: number;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGSTOP" | "SIGCONT";
  force?: boolean;
  children?: boolean;
}

interface ProcessMonitorOptions {
  pid?: number;
  interval?: number;
  duration?: number;
  metrics?: ("cpu" | "mem" | "io")[];
}

interface ProcessFindOptions {
  name?: string;
  user?: string;
  cmd?: string;
  exact?: boolean;
  limit?: number;
}

const ALLOWED_SIGNALS = ["SIGTERM", "SIGKILL", "SIGINT", "SIGSTOP", "SIGCONT"];

const PROCESS_LIST_CONFIG = {
  description: "List running processes",
  inputSchema: Schema.object({
    filter: Schema.string().optional().description("Filter processes by name or command"),
    user: Schema.string().optional().description("Filter by user"),
    name: Schema.string().optional().description("Filter by process name"),
    sort: Schema.enum(["pid", "cpu", "mem", "name", "time"]).optional().description("Sort by field"),
    limit: Schema.number().min(1).max(1000).optional().description("Limit number of results"),
    tree: Schema.boolean().optional().description("Show process tree"),
    format: Schema.enum(["json", "table"]).optional().description("Output format"),
  }),
};

const PROCESS_KILL_CONFIG = {
  description: "Kill a process by PID",
  inputSchema: Schema.object({
    pid: Schema.number().min(1).description("Process ID to kill"),
    signal: Schema.enum(ALLOWED_SIGNALS).optional().description("Signal to send"),
    force: Schema.boolean().optional().description("Force kill with SIGKILL"),
    children: Schema.boolean().optional().description("Also kill child processes"),
  }),
};

const PROCESS_MONITOR_CONFIG = {
  description: "Monitor process resource usage",
  inputSchema: Schema.object({
    pid: Schema.number().min(1).optional().description("Process ID to monitor"),
    interval: Schema.number().min(1).max(60).optional().description("Sampling interval in seconds"),
    duration: Schema.number().min(1).max(300).optional().description("Duration in seconds"),
    metrics: Schema.array(Schema.enum(["cpu", "mem", "io"])).optional().description("Metrics to collect"),
  }),
};

const PROCESS_FIND_CONFIG = {
  description: "Find processes by various criteria",
  inputSchema: Schema.object({
    name: Schema.string().optional().description("Process name to search for"),
    user: Schema.string().optional().description("User to filter by"),
    cmd: Schema.string().optional().description("Command pattern to search for"),
    exact: Schema.boolean().optional().description("Exact match instead of partial"),
    limit: Schema.number().min(1).max(1000).optional().description("Limit number of results"),
  }),
};

const PROCESS_TREE_CONFIG = {
  description: "Show process hierarchy",
  inputSchema: Schema.object({
    pid: Schema.number().min(1).optional().description("Root PID for the tree"),
    user: Schema.string().optional().description("Filter by user"),
    format: Schema.enum(["json", "tree"]).optional().description("Output format"),
  }),
};

const PROCESS_TOP_CONFIG = {
  description: "Show top processes by resource usage",
  inputSchema: Schema.object({
    by: Schema.enum(["cpu", "mem"]).optional().description("Sort by CPU or memory"),
    limit: Schema.number().min(1).max(100).optional().description("Number of processes to show"),
    interval: Schema.number().min(1).max(10).optional().description("Refresh interval"),
    count: Schema.number().min(1).max(100).optional().description("Number of updates"),
  }),
};

export default defineTool({
  name: "process",
  version: "1.0.0",
  description: "List, monitor, and manage processes",
  commands: {
    list: PROCESS_LIST_CONFIG,
    kill: PROCESS_KILL_CONFIG,
    monitor: PROCESS_MONITOR_CONFIG,
    find: PROCESS_FIND_CONFIG,
    tree: PROCESS_TREE_CONFIG,
    top: PROCESS_TOP_CONFIG,
    ps: PROCESS_LIST_CONFIG, // alias
  },
  async run(command: string, args: Record<string, unknown>) {
    switch (command) {
      case "list":
      case "ps":
        return listProcesses(args as unknown as ProcessListOptions);
      case "kill":
        return killProcess(args as unknown as ProcessKillOptions);
      case "monitor":
        return monitorProcess(args as unknown as ProcessMonitorOptions);
      case "find":
        return findProcesses(args as unknown as ProcessFindOptions);
      case "tree":
        return processTree(args);
      case "top":
        return topProcesses(args);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  },
});

function listProcesses(options: ProcessListOptions): ProcessInfo[] | string {
  const processes = getProcessList();

  let filtered = processes;

  // Apply filters
  if (options.filter) {
    const pattern = options.filter.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(pattern) ||
        (p.cmd && p.cmd.toLowerCase().includes(pattern))
    );
  }

  if (options.user) {
    filtered = filtered.filter((p) => p.user === options.user);
  }

  if (options.name) {
    const pattern = options.name.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(pattern));
  }

  // Sort
  if (options.sort) {
    filtered.sort((a, b) => {
      switch (options.sort) {
        case "pid":
          return a.pid - b.pid;
        case "cpu":
          return (b.cpu || 0) - (a.cpu || 0);
        case "mem":
          return (b.mem || 0) - (a.mem || 0);
        case "name":
          return a.name.localeCompare(b.name);
        case "time":
          return (a.elapsed || "").localeCompare(b.elapsed || "");
        default:
          return 0;
      }
    });
  }

  // Limit
  if (options.limit && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  // Format output
  if (options.format === "table" || !options.format) {
    return formatProcessTable(filtered);
  }

  return filtered;
}

function killProcess(options: ProcessKillOptions): string {
  const { pid, signal = "SIGTERM", force, children } = options;

  // Determine signal
  const actualSignal = force ? "SIGKILL" : signal;

  if (!ALLOWED_SIGNALS.includes(actualSignal)) {
    throw new Error(`Invalid signal: ${actualSignal}`);
  }

  try {
    // Check if process exists
    process.kill(pid, 0);

    // Kill children if requested
    if (children) {
      const childPids = getChildProcesses(pid);
      for (const childPid of childPids) {
        try {
          process.kill(childPid, actualSignal as NodeJS.Signals);
        } catch {
          // Child may have already exited
        }
      }
    }

    // Kill the main process
    process.kill(pid, actualSignal as NodeJS.Signals);

    return `Sent ${actualSignal} to process ${pid}${children ? ` and its children` : ""}`;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw new Error(`Process ${pid} not found`);
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      throw new Error(`Permission denied to kill process ${pid}`);
    }
    throw error;
  }
}

function monitorProcess(options: ProcessMonitorOptions): Promise<string> {
  return new Promise((resolve) => {
    const { pid, interval = 1, duration = 10, metrics = ["cpu", "mem"] } = options;
    const samples: Array<{ time: number; data: Record<string, unknown> }> = [];
    const startTime = Date.now();
    const maxSamples = Math.floor(duration / interval);

    const collectSample = () => {
      const elapsed = Date.now() - startTime;
      const sample: { time: number; data: Record<string, unknown> } = {
        time: elapsed,
        data: {},
      };

      try {
        if (pid) {
          // Monitor specific process
          const info = getProcessInfo(pid);
          if (!info) {
            resolve(`Process ${pid} not found or exited`);
            return;
          }

          if (metrics.includes("cpu")) sample.data.cpu = info.cpu;
          if (metrics.includes("mem")) sample.data.mem = info.mem;
        } else {
          // Monitor system-wide
          if (metrics.includes("cpu")) sample.data.cpu = getSystemCpu();
          if (metrics.includes("mem")) sample.data.mem = getSystemMemory();
        }

        samples.push(sample);

        if (samples.length >= maxSamples) {
          clearInterval(timer);
          resolve(formatMonitorOutput(samples));
        }
      } catch {
        // Process may have exited
        clearInterval(timer);
        if (samples.length > 0) {
          resolve(formatMonitorOutput(samples) + `\n\nProcess ${pid} exited`);
        } else {
          resolve(`Process ${pid} not found or exited immediately`);
        }
      }
    };

    // Collect immediately and then at interval
    collectSample();
    const timer = setInterval(collectSample, interval * 1000);
  });
}

function findProcesses(options: ProcessFindOptions): ProcessInfo[] | string {
  const processes = getProcessList();

  let filtered = processes;

  if (options.name) {
    const pattern = options.exact
      ? options.name.toLowerCase()
      : options.name.toLowerCase();
    filtered = filtered.filter((p) =>
      options.exact
        ? p.name.toLowerCase() === pattern
        : p.name.toLowerCase().includes(pattern)
    );
  }

  if (options.user) {
    filtered = filtered.filter((p) => p.user === options.user);
  }

  if (options.cmd) {
    const pattern = options.cmd.toLowerCase();
    filtered = filtered.filter(
      (p) => p.cmd && p.cmd.toLowerCase().includes(pattern)
    );
  }

  if (options.limit && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

function processTree(args: Record<string, unknown>): string {
  const pid = args.pid as number | undefined;
  const user = args.user as string | undefined;

  const processes = getProcessList();
  const filtered = user ? processes.filter((p) => p.user === user) : processes;

  if (pid) {
    // Show tree from specific PID
    const tree = buildProcessTree(filtered, pid);
    return renderTree(tree, 0);
  }

  // Show all trees (root processes)
  const roots = filtered.filter((p) => !filtered.some((pp) => pp.pid === p.ppid));
  return roots.map((root) => renderTree(buildProcessTree(filtered, root.pid), 0)).join("\n");
}

function topProcesses(args: Record<string, unknown>): string {
  const by = (args.by as "cpu" | "mem") || "cpu";
  const limit = (args.limit as number) || 20;
  const interval = (args.interval as number) || 2;
  const count = (args.count as number) || 1;

  let iterations = 0;
  const output: string[] = [];

  const showTop = () => {
    const processes = getProcessList();
    const sorted = processes
      .sort((a, b) => (by === "cpu" ? (b.cpu || 0) - (a.cpu || 0) : (b.mem || 0) - (a.mem || 0)))
      .slice(0, limit);

    output.push(`\n=== Top ${limit} processes by ${by} (iteration ${iterations + 1}/${count}) ===\n`);
    output.push(formatProcessTable(sorted));
    iterations++;

    if (iterations >= count) {
      clearInterval(timer);
    }
  };

  showTop();
  const timer = setInterval(showTop, interval * 1000);

  // For simplicity, return after first iteration if count is 1
  if (count === 1) {
    clearInterval(timer);
    return output.join("\n");
  }

  // For multiple iterations, we'd need async handling
  // Simplified version just returns first iteration
  return output.join("\n");
}

// Helper functions

function getProcessList(): ProcessInfo[] {
  try {
    // Use ps command for comprehensive process info
    const output = execSync(
      'ps -eo pid,ppid,user,pcpu,pmem,stat,lstart,etime,comm,args --sort=pid',
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const lines = output.trim().split("\n").slice(1); // Skip header
    return lines.map((line) => parseProcessLine(line)).filter((p): p is ProcessInfo => p !== null);
  } catch {
    // Fallback to simpler ps output
    try {
      const output = execSync('ps -eo pid,ppid,comm', { encoding: "utf-8" });
      const lines = output.trim().split("\n").slice(1);
      return lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[0], 10),
          ppid: parseInt(parts[1], 10),
          name: parts[2] || "unknown",
        };
      }).filter((p) => !isNaN(p.pid));
    } catch {
      return [];
    }
  }
}

function parseProcessLine(line: string): ProcessInfo | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const pid = parseInt(parts[0], 10);
  const ppid = parseInt(parts[1], 10);
  const user = parts[2];
  const cpu = parseFloat(parts[3]);
  const mem = parseFloat(parts[4]);
  const state = parts[5];
  const startTime = parts.slice(6, 9).join(" ");
  const elapsed = parts[9];
  const name = parts[10] || "unknown";
  const cmd = parts.slice(10).join(" ");

  if (isNaN(pid)) return null;

  return {
    pid,
    ppid,
    user,
    cpu,
    mem,
    state,
    startTime,
    elapsed,
    name,
    cmd,
  };
}

function getProcessInfo(pid: number): ProcessInfo | null {
  try {
    const output = execSync(`ps -p ${pid} -o pid,ppid,user,pcpu,pmem,stat,etime,comm,args`, {
      encoding: "utf-8",
    });
    const line = output.trim().split("\n")[1];
    return line ? parseProcessLine(line) : null;
  } catch {
    return null;
  }
}

function getChildProcesses(parentPid: number): number[] {
  const processes = getProcessList();
  const children: number[] = [];

  const findChildren = (ppid: number) => {
    const directChildren = processes.filter((p) => p.ppid === ppid);
    for (const child of directChildren) {
      children.push(child.pid);
      findChildren(child.pid); // Recursively find grandchildren
    }
  };

  findChildren(parentPid);
  return children;
}

function buildProcessTree(processes: ProcessInfo[], rootPid: number): ProcessInfo & { children?: ProcessInfo[] } {
  const root = processes.find((p) => p.pid === rootPid);
  if (!root) {
    return { pid: rootPid, ppid: 0, name: "unknown" };
  }

  const children = processes
    .filter((p) => p.ppid === rootPid)
    .map((child) => buildProcessTree(processes, child.pid));

  return { ...root, children: children.length > 0 ? children : undefined };
}

function renderTree(node: ProcessInfo & { children?: ProcessInfo[] }, depth: number): string {
  const indent = "  ".repeat(depth);
  let result = `${indent}${node.pid} ${node.name}${node.cmd ? ` (${node.cmd.split(" ")[0]})` : ""}\n`;

  if (node.children) {
    for (const child of node.children) {
      result += renderTree(child, depth + 1);
    }
  }

  return result;
}

function formatProcessTable(processes: ProcessInfo[]): string {
  const lines: string[] = [];
  lines.push("  PID  PPID USER       CPU%  MEM%  STAT  ELAPSED   NAME");
  lines.push("─".repeat(70));

  for (const p of processes.slice(0, 100)) {
    const pid = String(p.pid).padStart(5);
    const ppid = String(p.ppid).padStart(5);
    const user = (p.user || "-").padEnd(10).slice(0, 10);
    const cpu = (p.cpu !== undefined ? p.cpu.toFixed(1) : "-").padStart(4);
    const mem = (p.mem !== undefined ? p.mem.toFixed(1) : "-").padStart(4);
    const stat = (p.state || "-").padEnd(5);
    const elapsed = (p.elapsed || "-").padEnd(9);
    const name = p.name.slice(0, 20);

    lines.push(`${pid} ${ppid} ${user} ${cpu}% ${mem}% ${stat} ${elapsed} ${name}`);
  }

  return lines.join("\n");
}

function formatMonitorOutput(samples: Array<{ time: number; data: Record<string, unknown> }>): string {
  const lines: string[] = [];
  lines.push("Time(ms)    CPU%     MEM%");
  lines.push("─".repeat(30));

  for (const sample of samples) {
    const time = String(sample.time).padStart(7);
    const cpu = (sample.data.cpu !== undefined ? (sample.data.cpu as number).toFixed(1) : "-").padStart(6);
    const mem = (sample.data.mem !== undefined ? (sample.data.mem as number).toFixed(1) : "-").padStart(6);
    lines.push(`${time}   ${cpu}%   ${mem}%`);
  }

  return lines.join("\n");
}

function getSystemCpu(): number {
  try {
    // Simple CPU usage estimate
    const output = execSync("cat /proc/loadavg", { encoding: "utf-8" });
    const load = parseFloat(output.split(" ")[0]);
    return load * 100; // Rough approximation
  } catch {
    return 0;
  }
}

function getSystemMemory(): number {
  try {
    const output = execSync("cat /proc/meminfo", { encoding: "utf-8" });
    const lines = output.split("\n");
    let total = 0;
    let available = 0;

    for (const line of lines) {
      if (line.startsWith("MemTotal:")) {
        total = parseInt(line.split(/\s+/)[1], 10);
      } else if (line.startsWith("MemAvailable:")) {
        available = parseInt(line.split(/\s+/)[1], 10);
      }
    }

    if (total > 0) {
      return ((total - available) / total) * 100;
    }
    return 0;
  } catch {
    return 0;
  }
}
