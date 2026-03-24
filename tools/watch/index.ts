#!/usr/bin/env node
/**
 * File Watcher Tool for Beige Toolkit
 *
 * Watch files and directories for changes with flexible configuration.
 * Supports glob patterns, event filtering, and command execution.
 */

import { watch, type FSWatcher } from "fs";
import { existsSync, statSync, type Stats } from "fs";
import { join, relative, isAbsolute, resolve } from "path";
import { spawn } from "child_process";

// Types
interface WatcherConfig {
  maxWatchers?: number;
  maxHistory?: number;
  allowPaths?: string[];
  denyPaths?: string[];
}

interface WatchOptions {
  path: string;
  events?: ("change" | "create" | "delete")[];
  recursive?: boolean;
  pattern?: string;
  command?: string;
  debounce?: number;
  name?: string;
}

interface Watcher {
  id: string;
  name?: string;
  path: string;
  events: ("change" | "create" | "delete")[];
  recursive: boolean;
  pattern?: RegExp;
  command?: string;
  debounce: number;
  fsWatcher?: FSWatcher;
  startedAt: Date;
  lastEvent?: Date;
  eventCount: number;
  debounceTimers: Map<string, NodeJS.Timeout>;
}

interface FileEvent {
  watcherId: string;
  event: "change" | "create" | "delete";
  path: string;
  timestamp: Date;
  commandOutput?: string;
}

interface CommandResult {
  watcher: Watcher;
  event: FileEvent;
}

// State
const watchers = new Map<string, Watcher>();
const eventHistory: FileEvent[] = [];
let config: WatcherConfig = {};
let watcherCounter = 0;

// Parse CLI arguments
function parseArgs(): { command: string; params: Record<string, unknown> } {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    return { command: "list", params: {} };
  }

  const command = args[0];
  const params: Record<string, unknown> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        // Try to parse as JSON, fall back to string
        try {
          params[key] = JSON.parse(value);
        } catch {
          params[key] = value;
        }
        i++;
      } else {
        params[key] = true;
      }
    }
  }

  return { command, params };
}

// Convert glob pattern to regex
function globToRegex(pattern: string): RegExp {
  const regex = pattern
    .replace(/\*\*/g, "<<<DOUBLE_STAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLE_STAR>>>/g, ".*")
    .replace(/\?/g, "[^/]")
    .replace(/\./g, "\\.");
  return new RegExp(`^${regex}$`);
}

// Check if path matches pattern
function matchesPattern(filePath: string, pattern?: RegExp): boolean {
  if (!pattern) return true;
  return pattern.test(filePath);
}

// Check if path is allowed
function isPathAllowed(pathToCheck: string): boolean {
  const resolved = resolve(pathToCheck);

  // Check deny list first
  if (config.denyPaths) {
    for (const denied of config.denyPaths) {
      if (resolved.includes(resolve(denied))) {
        return false;
      }
    }
  }

  // Check allow list
  if (config.allowPaths && config.allowPaths.length > 0) {
    for (const allowed of config.allowPaths) {
      if (resolved.includes(resolve(allowed))) {
        return true;
      }
    }
    return false;
  }

  // Default: allow workspace paths only
  const workspace = process.cwd();
  return resolved.startsWith(workspace);
}

// Execute command on file change
function executeCommand(
  watcher: Watcher,
  event: FileEvent
): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    if (!watcher.command) {
      resolvePromise(undefined);
      return;
    }

    // Replace placeholders in command
    let cmd = watcher.command
      .replace(/\{file\}/g, event.path)
      .replace(/\{event\}/g, event.event)
      .replace(/\{watcher\}/g, watcher.id);

    const child = spawn("sh", ["-c", cmd], {
      cwd: process.cwd(),
      timeout: 30000,
    });

    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", () => {
      resolvePromise(output.trim() || undefined);
    });

    child.on("error", (err) => {
      resolvePromise(`Error: ${err.message}`);
    });
  });
}

// Handle file system event
async function handleEvent(
  watcher: Watcher,
  event: "change" | "create" | "delete",
  filePath: string
): Promise<void> {
  // Check pattern
  if (!matchesPattern(filePath, watcher.pattern)) {
    return;
  }

  // Check if event type is watched
  if (!watcher.events.includes(event)) {
    return;
  }

  // Debounce
  const key = `${filePath}:${event}`;
  const existingTimer = watcher.debounceTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  watcher.debounceTimers.set(
    key,
    setTimeout(async () => {
      watcher.debounceTimers.delete(key);

      const fileEvent: FileEvent = {
        watcherId: watcher.id,
        event,
        path: filePath,
        timestamp: new Date(),
      };

      // Execute command if specified
      if (watcher.command) {
        fileEvent.commandOutput = await executeCommand(watcher, fileEvent);
      }

      // Update watcher stats
      watcher.lastEvent = fileEvent.timestamp;
      watcher.eventCount++;

      // Add to history
      eventHistory.push(fileEvent);
      const maxHistory = config.maxHistory || 100;
      if (eventHistory.length > maxHistory) {
        eventHistory.shift();
      }

      // Output event
      output({
        type: "event",
        watcherId: watcher.id,
        event: fileEvent,
      });
    }, watcher.debounce)
  );
}

// Start watching
async function startWatcher(params: WatchOptions): Promise<Watcher> {
  const { path: watchPath, events, recursive = true, pattern, command, debounce = 100, name } = params;

  // Check max watchers
  const maxWatchers = config.maxWatchers || 10;
  if (watchers.size >= maxWatchers) {
    throw new Error(`Maximum watchers (${maxWatchers}) reached. Stop some watchers first.`);
  }

  // Validate path
  if (!existsSync(watchPath)) {
    throw new Error(`Path does not exist: ${watchPath}`);
  }

  if (!isPathAllowed(watchPath)) {
    throw new Error(`Path not allowed: ${watchPath}`);
  }

  // Create watcher
  const id = `watch-${++watcherCounter}`;
  const watcher: Watcher = {
    id,
    name,
    path: resolve(watchPath),
    events: events || ["change", "create", "delete"],
    recursive,
    pattern: pattern ? globToRegex(pattern) : undefined,
    command,
    debounce,
    startedAt: new Date(),
    eventCount: 0,
    debounceTimers: new Map(),
  };

  // Start FS watcher
  const stats = statSync(watchPath);
  const isDirectory = stats.isDirectory();

  watcher.fsWatcher = watch(
    watcher.path,
    {
      recursive: isDirectory && recursive,
      persistent: true,
    },
    async (eventType, filename) => {
      if (!filename) return;

      const fullPath = isDirectory ? join(watcher.path, filename) : watcher.path;
      const relativePath = relative(watcher.path, fullPath);

      // Map event type
      let fsEvent: "change" | "create" | "delete";
      if (eventType === "rename") {
        // Check if file exists to determine create vs delete
        fsEvent = existsSync(fullPath) ? "create" : "delete";
      } else {
        fsEvent = "change";
      }

      await handleEvent(watcher, fsEvent, relativePath);
    }
  );

  watcher.fsWatcher?.on("error", (err) => {
    output({
      type: "error",
      watcherId: id,
      error: err.message,
    });
  });

  watchers.set(id, watcher);

  return watcher;
}

// Stop watcher
function stopWatcher(id: string): boolean {
  const watcher = watchers.get(id);
  if (!watcher) {
    return false;
  }

  // Clear debounce timers
  for (const timer of watcher.debounceTimers.values()) {
    clearTimeout(timer);
  }

  // Close FS watcher
  watcher.fsWatcher?.close();

  watchers.delete(id);
  return true;
}

// List watchers
function listWatchers(): Watcher[] {
  return Array.from(watchers.values());
}

// Clear all watchers
function clearWatchers(): number {
  const count = watchers.size;
  for (const id of watchers.keys()) {
    stopWatcher(id);
  }
  return count;
}

// Get history
function getHistory(watcherId?: string, limit = 20): FileEvent[] {
  let events = eventHistory;
  if (watcherId) {
    events = events.filter((e) => e.watcherId === watcherId);
  }
  return events.slice(-limit);
}

// Output helper
function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// Main
async function main(): Promise<void> {
  // Load config from environment
  if (process.env.BEIGE_TOOL_CONFIG) {
    try {
      config = JSON.parse(process.env.BEIGE_TOOL_CONFIG);
    } catch {
      // Ignore parse errors
    }
  }

  const { command, params } = parseArgs();

  try {
    switch (command) {
      case "start": {
        const watcher = await startWatcher(params as WatchOptions);
        output({
          success: true,
          watcher: {
            id: watcher.id,
            name: watcher.name,
            path: watcher.path,
            events: watcher.events,
            recursive: watcher.recursive,
            pattern: params.pattern,
            command: watcher.command,
            startedAt: watcher.startedAt,
          },
        });
        break;
      }

      case "stop": {
        const id = params.id as string;
        if (!id) {
          throw new Error("Missing required parameter: id");
        }
        const stopped = stopWatcher(id);
        output({
          success: stopped,
          message: stopped ? `Watcher ${id} stopped` : `Watcher ${id} not found`,
        });
        break;
      }

      case "list": {
        const list = listWatchers().map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          events: w.events,
          recursive: w.recursive,
          command: w.command,
          startedAt: w.startedAt,
          lastEvent: w.lastEvent,
          eventCount: w.eventCount,
        }));
        output({
          success: true,
          watchers: list,
          count: list.length,
        });
        break;
      }

      case "clear": {
        const count = clearWatchers();
        output({
          success: true,
          message: `Stopped ${count} watcher(s)`,
        });
        break;
      }

      case "history": {
        const events = getHistory(params.id as string, (params.limit as number) || 20);
        output({
          success: true,
          events,
          count: events.length,
        });
        break;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    output({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
