/**
 * spawn tool
 *
 * Allows a beige agent to spawn another agent (or itself as a sub-agent) and
 * hold a multi-turn conversation with it.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * When an agent calls this tool, the gateway:
 *   1. Checks that the target agent is listed in the tool's `targets` config.
 *   2. Checks that the call would not exceed the configured depth limit
 *      (per-target `maxDepth` or the global default).  Depth is stored as
 *      opaque metadata on the session entry in beige's session map — beige
 *      itself never interprets it.
 *   3. Creates a new session for the target agent (or resumes an existing one
 *      if --session is supplied).
 *   4. Sends the message to the target agent and waits for the full response.
 *   5. Returns the response plus a SESSION key the caller can use for
 *      follow-up turns.
 *
 * ── Config model ────────────────────────────────────────────────────────────
 *
 * The `targets` object lists which agents can be spawned.  Each key is a
 * target agent name with an optional `maxDepth` override.  The special key
 * `"SELF"` resolves to the calling agent's own name at runtime, enabling
 * sub-agent patterns without naming a specific agent.
 *
 * Because beige supports per-agent `toolConfigs` overrides (deep-merged with
 * the top-level tool config), different agents can have different target lists.
 * The top-level config defines the baseline; an agent's `toolConfigs` entry
 * narrows or extends it.
 *
 * ── Output format ───────────────────────────────────────────────────────────
 *
 * Every successful call returns:
 *
 *   SESSION: <session-key>
 *   ---
 *   <target agent's full response>
 *
 * The SESSION line is always first so the caller can extract it reliably with
 * a simple prefix match.  Pass the key back via --session on follow-up calls
 * to continue the same conversation thread.
 *
 * ── Session lifecycle ───────────────────────────────────────────────────────
 *
 * - Omitting --session always creates a fresh session, even when calling the
 *   same target repeatedly.  This lets callers maintain independent parallel
 *   conversations with the same agent.
 * - Supplying --session resumes that exact conversation (same history, same
 *   model context).
 * - Sessions created by this tool are normal beige sessions and persist on
 *   disk across gateway restarts.
 *
 * ── Depth enforcement ───────────────────────────────────────────────────────
 *
 * Depth is tracked via session metadata (a field opaque to beige):
 *
 *   Top-level session (human → agent):  depth = 0  (no metadata, defaults to 0)
 *   First sub-agent spawn:              depth = 1
 *   Second sub-agent spawn:             depth = 2  …and so on
 *
 * Each target in the `targets` config can have its own `maxDepth`.  When not
 * set, the top-level `maxDepth` default (1) applies.
 *
 * When the effective maxDepth for a target is 1, depth-1 sessions are blocked
 * from spawning further agents to that target.  The check reads the caller's
 * session entry from the session store; if no entry exists (i.e. the key is
 * not in the session map — possible in tests or unusual scenarios) depth
 * defaults to 0.
 *
 * ── Security model ──────────────────────────────────────────────────────────
 *
 * - No targets are allowed by default.  The `targets` config must be
 *   explicitly set or every call returns a permission error.
 * - The `"SELF"` key is resolved at runtime to the calling agent's name,
 *   allowing sub-agent creation without hardcoding agent names.
 * - Per-agent restrictions can be applied via beige's `toolConfigs` override
 *   mechanism — each agent deep-merges its own config on top of the baseline.
 * - Per-target `maxDepth` overrides cap recursive depth independently.
 * - The tool validates that the target agent name exists in the beige config
 *   before forwarding the call; unknown agents are rejected immediately.
 *
 * ── Dependency injection ────────────────────────────────────────────────────
 *
 * createHandler accepts an optional second argument for testing:
 *
 *   { agentManagerRef?, sessionStore?, beigeConfig? }
 *
 * In production, beige passes the real agentManagerRef, sessionStore, and
 * beigeConfig through ToolHandlerContext.  Tests inject stubs directly.
 */

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Types — kept self-contained so no beige source imports are needed.
// ---------------------------------------------------------------------------

/** Subset of AgentManager used by this tool. */
export interface AgentManagerLike {
  prompt(sessionKey: string, agentName: string, message: string): Promise<string>;
}

/** Subset of BeigeSessionStore used by this tool. */
export interface SessionStoreLike {
  getEntry(key: string): SessionEntryLike | undefined;
  createSession(key: string, agentName: string, metadata?: Record<string, unknown>): string;
}

export interface SessionEntryLike {
  agentName: string;
  metadata?: Record<string, unknown>;
}

/** Subset of BeigeConfig used by this tool. */
export interface BeigeConfigLike {
  agents: Record<string, unknown>;
}

/**
 * Per-target configuration.
 */
export interface TargetConfig {
  /**
   * Maximum nesting depth for calls to this target.
   * Overrides the top-level maxDepth when set.
   */
  maxDepth?: number;
}

/**
 * Tool config supplied via config.json5.
 *
 * The `targets` object lists which agents can be called.  Each key is a target
 * agent name with an optional per-target config.  The special key `"SELF"`
 * resolves to the calling agent's own name at runtime, enabling sub-agent
 * patterns.
 *
 * Per-agent restrictions are handled via beige's `toolConfigs` override
 * mechanism — no per-caller mapping is needed in this config.
 */
export interface SpawnConfig {
  /**
   * Map of target agent names to their config.
   * Key: agent name (or the special keyword "SELF" for self-invocation).
   * Value: optional per-target config (e.g. maxDepth override).
   *
   * Absent = no agent is permitted to be spawned.
   */
  targets?: Record<string, TargetConfig>;

  /**
   * Default maximum nesting depth for targets that don't specify their own.
   * Default: 1.
   * 0 = all spawns blocked regardless of targets.
   * 1 = agents may spawn agents; those sub-agents may not spawn further agents.
   */
  maxDepth?: number;
}

/**
 * Context injected by the gateway (or by tests).
 */
export interface SpawnContext {
  /** Mutable ref — beige populates .current after AgentManager is created. */
  agentManagerRef?: { current: AgentManagerLike | null };
  sessionStore?: SessionStoreLike;
  beigeConfig?: BeigeConfigLike;
}

/** Extended SessionContext shape — includes agentName injected by beige since v0.1.x. */
interface IncomingSessionContext {
  sessionKey?: string;
  channel?: string;
  /** Agent name, set by AgentManager and passed through BEIGE_AGENT_NAME env var. */
  agentName?: string;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: IncomingSessionContext
) => Promise<{ output: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Session key generation
// ---------------------------------------------------------------------------

function generateChildSessionKey(
  callerSessionKey: string,
  targetAgent: string
): string {
  const now = new Date();
  const ts =
    now.toISOString().slice(0, 10).replace(/-/g, "") +
    "-" +
    now.toISOString().slice(11, 19).replace(/:/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 8);
  return `spawn:${callerSessionKey}:${targetAgent}:${ts}`;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  target: string | null;
  session: string | null;
  messageFile: string | null;
  info: boolean;
  messageParts: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    target: null,
    session: null,
    messageFile: null,
    info: false,
    messageParts: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if ((arg === "--target" || arg === "-t") && i + 1 < args.length) {
      result.target = args[++i];
    } else if ((arg === "--session" || arg === "-s") && i + 1 < args.length) {
      result.session = args[++i];
    } else if (arg === "--message-file" && i + 1 < args.length) {
      result.messageFile = args[++i];
    } else if (arg === "--info" || arg === "-i") {
      result.info = true;
    } else if (arg === "--") {
      result.messageParts.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      result.messageParts.push(arg);
    } else {
      // Unknown flag — ignore so future flags are non-breaking
    }
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Target resolution — handles SELF keyword
// ---------------------------------------------------------------------------

/**
 * Resolve the effective target set for a given caller agent.
 *
 * The `"SELF"` key in `targets` is expanded to the caller's own name.
 * Returns a Map from resolved target name → TargetConfig.
 */
export function resolveTargets(
  targets: Record<string, TargetConfig> | undefined,
  callerAgent: string
): Map<string, TargetConfig> {
  const resolved = new Map<string, TargetConfig>();
  if (!targets) return resolved;

  for (const [key, cfg] of Object.entries(targets)) {
    const resolvedKey = key === "SELF" ? callerAgent : key;
    resolved.set(resolvedKey, cfg);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Usage and info text
// ---------------------------------------------------------------------------

function usageText(resolvedTargets: Map<string, TargetConfig>): string {
  const permitted = resolvedTargets.size > 0
    ? [...resolvedTargets.keys()].join(", ")
    : "(none configured)";
  return [
    "Usage: spawn --target <agent> [--session <key>] <message...>",
    "       spawn --target <agent> [--session <key>] --message-file <path>",
    "       spawn --info",
    "",
    "Start a new conversation:",
    "  spawn --target reviewer Please review the code in /workspace/src",
    "",
    "Continue an existing conversation:",
    "  spawn --target reviewer --session <key> Thanks, can you also check the tests?",
    "",
    "Show your spawn permissions:",
    "  spawn --info",
    "",
    `Targets you may call: ${permitted}`,
  ].join("\n");
}

function buildInfoResponse(
  callerAgent: string,
  callerDepth: number,
  defaultMaxDepth: number,
  resolvedTargets: Map<string, TargetConfig>,
  rawTargets: Record<string, TargetConfig> | undefined,
  beigeConfig: BeigeConfigLike | undefined
): { output: string; exitCode: number } {
  const lines: string[] = [
    "spawn — permissions for this session",
    "═══════════════════════════════════════",
    "",
    `Current agent:      ${callerAgent}`,
    `Current depth:      ${callerDepth}`,
    `Default max depth:  ${defaultMaxDepth}`,
    "",
  ];

  if (!rawTargets || Object.keys(rawTargets).length === 0) {
    lines.push("Status: DISABLED — no targets configured.");
    lines.push("No spawns can be made until targets is set in config.json5.");
  } else {
    if (resolvedTargets.size === 0) {
      lines.push("Status: DISABLED — no targets resolved for this agent.");
    } else {
      // Check if at least one target is reachable at current depth
      const reachable = [...resolvedTargets.entries()].filter(
        ([, cfg]) => callerDepth < (cfg.maxDepth ?? defaultMaxDepth)
      );

      if (reachable.length === 0) {
        lines.push("Status: BLOCKED — this session is at or above the maximum allowed depth for all targets.");
      } else {
        lines.push(`Status: ACTIVE — ${reachable.length} target(s) reachable from current depth.`);
      }

      lines.push("");
      lines.push(`Targets (${resolvedTargets.size}):`);
      for (const [target, cfg] of resolvedTargets) {
        const effectiveDepth = cfg.maxDepth ?? defaultMaxDepth;
        const remaining = effectiveDepth - callerDepth;
        const isSelf = target === callerAgent;
        const knownInConfig = beigeConfig ? (beigeConfig.agents[target] !== undefined) : null;
        const blocked = remaining <= 0;
        const suffix = [
          isSelf ? "sub-agent" : null,
          `maxDepth: ${effectiveDepth}`,
          blocked ? "BLOCKED at current depth" : `${remaining} level(s) remaining`,
          knownInConfig === false ? "⚠ not in beige config" : null,
        ].filter(Boolean).join(", ");
        lines.push(`  • ${target}  (${suffix})`);
      }
    }

    // Show raw targets config for reference
    if (rawTargets && Object.keys(rawTargets).length > 0) {
      lines.push("");
      lines.push("Raw targets config (before SELF resolution):");
      for (const [key, cfg] of Object.entries(rawTargets)) {
        const depthStr = cfg.maxDepth !== undefined ? `maxDepth: ${cfg.maxDepth}` : "default depth";
        lines.push(`  ${key} → ${depthStr}`);
      }
    }
  }

  lines.push("");
  lines.push(`Note: sub-agents created by this session will have depth ${callerDepth + 1}.`);

  return { output: lines.join("\n"), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// createHandler — entry point called by the beige gateway at startup
// ---------------------------------------------------------------------------

export function createHandler(
  config: SpawnConfig,
  context: SpawnContext = {}
): ToolHandler {
  const { agentManagerRef, sessionStore, beigeConfig } = context;
  const defaultMaxDepth = config.maxDepth ?? 1;
  const rawTargets = config.targets;

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: IncomingSessionContext
  ): Promise<{ output: string; exitCode: number }> => {
    // ── Resolve live dependencies ──────────────────────────────────────────
    const agentManager = agentManagerRef?.current ?? null;
    if (!agentManager) {
      return {
        output: "spawn: gateway not ready (AgentManager unavailable). Try again in a moment.",
        exitCode: 1,
      };
    }

    // ── Identify the calling agent ─────────────────────────────────────────
    const callerSessionKey = sessionContext?.sessionKey;
    const callerEntry = callerSessionKey ? sessionStore?.getEntry(callerSessionKey) : undefined;
    const callerAgent =
      sessionContext?.agentName ??
      callerEntry?.agentName ??
      "unknown";

    // ── Resolve targets (expand SELF) ──────────────────────────────────────
    const resolvedTargets = resolveTargets(rawTargets, callerAgent);

    // ── Parse args ─────────────────────────────────────────────────────────
    if (args.length === 0) {
      return {
        output: usageText(resolvedTargets),
        exitCode: 1,
      };
    }

    const parsed = parseArgs(args);

    if (!parsed.target && !parsed.info) {
      return {
        output: ["Error: --target <agent> is required.", "", usageText(resolvedTargets)].join("\n"),
        exitCode: 1,
      };
    }

    // After this point, either parsed.info is true (handled below and returns early)
    // or parsed.target is a non-null string (guaranteed by the guard above).
    const target = parsed.target as string;

    // ── Depth check ────────────────────────────────────────────────────────
    const callerDepth = (callerEntry?.metadata?.depth as number | undefined) ?? 0;

    // ── --info: show what this agent is allowed to do ──────────────────────
    if (parsed.info) {
      return buildInfoResponse(callerAgent, callerDepth, defaultMaxDepth, resolvedTargets, rawTargets, beigeConfig);
    }

    // ── Permission check ───────────────────────────────────────────────────
    if (!rawTargets || Object.keys(rawTargets).length === 0) {
      return {
        output: [
          "Error: No targets configured for the spawn tool.",
          "Spawning is disabled until targets is set in config.json5.",
          "",
          "Example config:",
          "  config: {",
          `    targets: { "${target}": {} }`,
          "  }",
        ].join("\n"),
        exitCode: 1,
      };
    }

    if (!resolvedTargets.has(target)) {
      const permitted = [...resolvedTargets.keys()].join(", ") || "(none)";
      return {
        output: [
          `Error: Target agent '${target}' is not in the configured targets.`,
          `Configured targets: ${permitted}`,
          "",
          "Update the targets config in the spawn tool to grant access.",
          "Run 'spawn --info' to see your current permissions.",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Per-target depth check ─────────────────────────────────────────────
    const targetConfig = resolvedTargets.get(target)!;
    const effectiveMaxDepth = targetConfig.maxDepth ?? defaultMaxDepth;

    if (callerDepth >= effectiveMaxDepth) {
      return {
        output: [
          `Error: Agent call depth limit reached (current depth: ${callerDepth}, max for '${target}': ${effectiveMaxDepth}).`,
          "This session was itself created by another agent and is not permitted to make",
          "further spawns to this target.",
          "",
          "To allow deeper nesting, increase maxDepth in the spawn tool config.",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Validate target exists ─────────────────────────────────────────────
    if (beigeConfig && !beigeConfig.agents[target]) {
      const known = Object.keys(beigeConfig.agents).join(", ") || "(none)";
      return {
        output: [
          `Error: Unknown agent '${target}'.`,
          `Known agents: ${known}`,
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Resolve message ────────────────────────────────────────────────────
    let message: string;

    if (parsed.messageFile) {
      try {
        message = readFileSync(parsed.messageFile, "utf-8").trim();
      } catch (err) {
        return {
          output: `Error: Could not read message file '${parsed.messageFile}': ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    } else {
      message = parsed.messageParts.join(" ").trim();
    }

    if (!message) {
      return {
        output: ["Error: No message provided.", "", usageText(resolvedTargets)].join("\n"),
        exitCode: 1,
      };
    }

    // ── Resolve or create child session ────────────────────────────────────
    let childSessionKey: string;

    if (parsed.session) {
      // Resuming an existing session.
      // Validate that the session exists and belongs to the requested target.
      if (!sessionStore) {
        return {
          output: "spawn: session store unavailable — cannot validate --session key.",
          exitCode: 1,
        };
      }
      const existingEntry = sessionStore.getEntry(parsed.session);
      if (!existingEntry) {
        return {
          output: [
            `Error: Session '${parsed.session}' not found.`,
            "Either the session key is wrong or the session was never created through this tool.",
          ].join("\n"),
          exitCode: 1,
        };
      }
      if (existingEntry.agentName !== target) {
        return {
          output: [
            `Error: Session '${parsed.session}' belongs to agent '${existingEntry.agentName}',`,
            `but --target '${target}' was specified. Pass the correct agent name.`,
          ].join("\n"),
          exitCode: 1,
        };
      }
      childSessionKey = parsed.session;
    } else {
      // New session — generate a unique key and register it with depth metadata.
      childSessionKey = generateChildSessionKey(callerSessionKey ?? "unknown", target);
      if (sessionStore) {
        sessionStore.createSession(childSessionKey, target, {
          depth: callerDepth + 1,
          parentSessionKey: callerSessionKey ?? null,
          invokedBy: callerAgent,
        });
      }
    }

    // ── Invoke the target agent ────────────────────────────────────────────
    let response: string;
    try {
      response = await agentManager.prompt(childSessionKey, target, message);
    } catch (err) {
      return {
        output: [
          `Error: Agent '${target}' failed to respond.`,
          err instanceof Error ? err.message : String(err),
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Return response with session key ───────────────────────────────────
    return {
      output: [`SESSION: ${childSessionKey}`, "---", response].join("\n"),
      exitCode: 0,
    };
  };
}
