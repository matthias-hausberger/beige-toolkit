#!/usr/bin/env bun
/**
 * File Watcher Tool - Monitor files and directories for changes
 *
 * Commands:
 *   start   - Start watching a path
 *   stop    - Stop a watcher
 *   list    - List active watchers
 *   clear   - Stop all watchers
 *   history - Show recent file change events
 */

import { watch as nodeWatch, type FSWatcher } from "node:fs";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

// Simple glob pattern matcher
function minimatch(str: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{DOUBLESTAR}}/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regex}$`).test(str);
}

// Types
interface WatchEvent {
  timestamp: string;
  watcherId: string;
  event: "create" | "modify" | "delete" | "rename";
  path: string;
  file?: string;
}

interface Watcher {
  id: string;
  path: string;
  events: string[];
  pattern?: string;
  commandOnEvent?: string;
  recursive: boolean;
  startedAt: string;
  fsWatcher?: FSWatcher;
}

interface Config {
  allowPaths?: string[];
  denyPaths?: string[];
  maxWatchers?: number;
  maxHistorySize?: number;
  defaultDebounce?: number;
}

interface ToolConfig {
  config?: Config;
}

interface ToolInput {
  command: string;
  path?: string;
  watcherId?: string;
  events?: string[];
  pattern?: string;
  commandOnEvent?: string;
  debounce?: number;
  recursive?: boolean;
  limit?: number;
}

// State
const watchers = new Map<string, Watcher>();
const history: WatchEvent[] = [];

// Generate unique watcher ID
function generateWatcherId(): string {
  return `watch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Check if path matches any pattern in list
function matchesPattern(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(path, pattern)) {
      return true;
    }
  }
  return false;
}

// Check if path is allowed
function isPathAllowed(path: string, config: Config): { allowed: boolean; reason?: string } {
  const absolutePath = path.startsWith("/") ? path : join(process.cwd(), path);

  // Check deny list first (takes precedence)
  if (config.denyPaths && config.denyPaths.length > 0) {
    if (matchesPattern(absolutePath, config.denyPaths)) {
      return { allowed: false, reason: "Path is in deny list" };
    }
  }

  // Check allow list (if configured, path must match)
  if (config.allowPaths && config.allowPaths.length > 0) {
    if (!matchesPattern(absolutePath, config.allowPaths)) {
      return { allowed: false, reason: "Path is not in allow list" };
    }
  }

  // Check if path exists
  if (!existsSync(absolutePath)) {
    return { allowed: false, reason: "Path does not exist" };
  }

  return { allowed: true };
}

// Check if file matches pattern
function fileMatchesPattern(file: string, pattern?: string): boolean {
  if (!pattern) return true;
  return minimatch(file, pattern);
}

// Execute command with placeholders replaced (async, non-blocking)
async function executeCommand(command: string, event: WatchEvent): Promise<void> {
  const replacements: Record<string, string> = {
    "{file}": event.file || "",
    "{path}": event.path,
    "{event}": event.event,
  };

  let cmd = command;
  for (const [placeholder, value] of Object.entries(replacements)) {
    cmd = cmd.replace(new RegExp(placeholder.replace(/[{}]/g, "\\$&"), "g"), value);
  }

  try {
    // Use Bun's shell if available, otherwise fall back to exec
    const proc = Bun.spawn(cmd.split(" "), { quiet: true });
    await proc.exited;
  } catch {
    // Log but don't fail - commands are best-effort
    console.error(`Command failed: ${cmd}`);
  }
}

// Add event to history
function addToHistory(event: WatchEvent, config: Config): void {
  const maxSize = config.maxHistorySize || 1000;
  history.push(event);
  if (history.length > maxSize) {
    history.shift();
  }
}

// Start watching a path
async function startWatcher(
  input: ToolInput,
  config: Config
): Promise<{ success: boolean; watcherId?: string; error?: string }> {
  if (!input.path) {
    return { success: false, error: "Path is required for start command" };
  }

  // Check watcher limit
  const maxWatchers = config.maxWatchers || 10;
  if (watchers.size >= maxWatchers) {
    return {
      success: false,
      error: `Maximum number of watchers (${maxWatchers}) reached`,
    };
  }

  // Check path permissions
  const { allowed, reason } = isPathAllowed(input.path, config);
  if (!allowed) {
    return { success: false, error: reason };
  }

  const absolutePath = input.path.startsWith("/")
    ? input.path
    : join(process.cwd(), input.path);

  const events = input.events || ["create", "modify", "delete", "rename"];
  const recursive = input.recursive !== false;
  const debounce = input.debounce ?? config.defaultDebounce ?? 100;

  const watcherId = generateWatcherId();
  const watcher: Watcher = {
    id: watcherId,
    path: absolutePath,
    events,
    pattern: input.pattern,
    commandOnEvent: input.commandOnEvent,
    recursive,
    startedAt: new Date().toISOString(),
  };

  // Debounce tracking
  const lastEvents = new Map<string, number>();

  // Create file system watcher
  try {
    const fsWatcher = nodeWatch(
      absolutePath,
      { recursive, persistent: false },
      (eventType, filename) => {
        if (!filename) return;

        const filePath = join(absolutePath, filename);
        const file = basename(filePath);

        // Check pattern
        if (!fileMatchesPattern(file, input.pattern)) {
          return;
        }

        // Map event type
        let event: "create" | "modify" | "delete" | "rename";
        if (eventType === "rename") {
          event = existsSync(filePath) ? "create" : "delete";
        } else {
          event = "modify";
        }

        // Check if event type is watched
        if (!events.includes(event)) {
          return;
        }

        // Debounce
        const key = `${filePath}:${event}`;
        const now = Date.now();
        const last = lastEvents.get(key) || 0;
        if (now - last < debounce) {
          return;
        }
        lastEvents.set(key, now);

        // Create event
        const watchEvent: WatchEvent = {
          timestamp: new Date().toISOString(),
          watcherId,
          event,
          path: filePath,
          file,
        };

        // Add to history
        addToHistory(watchEvent, config);

        // Execute command if configured
        if (input.commandOnEvent) {
          executeCommand(input.commandOnEvent, watchEvent);
        }
      }
    );

    watcher.fsWatcher = fsWatcher;
    watchers.set(watcherId, watcher);

    return { success: true, watcherId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to start watcher",
    };
  }
}

// Stop a watcher
function stopWatcher(watcherId: string): { success: boolean; error?: string } {
  const watcher = watchers.get(watcherId);
  if (!watcher) {
    return { success: false, error: `Watcher ${watcherId} not found` };
  }

  if (watcher.fsWatcher) {
    watcher.fsWatcher.close();
  }
  watchers.delete(watcherId);

  return { success: true };
}

// List all watchers
function listWatchers(): { watchers: Array<Record<string, unknown>> } {
  const result = [];
  for (const [id, watcher] of watchers) {
    result.push({
      id,
      path: watcher.path,
      events: watcher.events,
      pattern: watcher.pattern,
      recursive: watcher.recursive,
      startedAt: watcher.startedAt,
    });
  }
  return { watchers: result };
}

// Clear all watchers
function clearWatchers(): { count: number } {
  const count = watchers.size;
  for (const watcher of watchers.values()) {
    if (watcher.fsWatcher) {
      watcher.fsWatcher.close();
    }
  }
  watchers.clear();
  return { count };
}

// Show history
function showHistory(limit: number = 50): { events: WatchEvent[] } {
  const events = history.slice(-limit);
  return { events };
}

// Main tool function
export default async function (input: ToolInput, context?: ToolConfig) {
  const config = context?.config || {};

  switch (input.command) {
    case "start":
      return await startWatcher(input, config);

    case "stop":
      if (!input.watcherId) {
        return { success: false, error: "watcherId is required for stop command" };
      }
      return stopWatcher(input.watcherId);

    case "list":
      return listWatchers();

    case "clear":
      return clearWatchers();

    case "history":
      return showHistory(input.limit);

    default:
      return { success: false, error: `Unknown command: ${input.command}` };
  }
}
