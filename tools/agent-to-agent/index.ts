/**
 * agent-to-agent tool
 *
 * Allows a beige agent to invoke another agent (or itself as a sub-agent) and
 * hold a multi-turn conversation with it.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * When an agent calls this tool, the gateway:
 *   1. Checks that the calling agent is permitted to invoke the target agent
 *      (via allowedTargets config).
 *   2. Checks that the call would not exceed the configured nesting depth
 *      (maxDepth).  Depth is stored as opaque metadata on the session entry
 *      in beige's session map — beige itself never interprets it.
 *   3. Creates a new session for the target agent (or resumes an existing one
 *      if --session is supplied).
 *   4. Sends the message to the target agent and waits for the full response.
 *   5. Returns the response plus a SESSION key the caller can use for
 *      follow-up turns.
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
 *   First sub-agent call:               depth = 1
 *   Second sub-agent call:              depth = 2  …and so on
 *
 * When maxDepth = 1 (the default), depth-1 sessions are blocked from making
 * further agent-to-agent calls.  The check reads the caller's session entry
 * from the session store; if no entry exists (i.e. the key is not in the
 * session map — possible in tests or unusual scenarios) depth defaults to 0.
 *
 * ── Security model ──────────────────────────────────────────────────────────
 *
 * - No targets are allowed by default.  allowedTargets must be explicitly
 *   configured or every call returns a permission error.
 * - An agent can only call targets listed in allowedTargets[callerAgentName].
 * - Sub-agent calls are just self-calls: include the agent's own name in its
 *   allowedTargets list.
 * - maxDepth caps recursive depth regardless of allowedTargets.
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
 * Tool config supplied via config.json5.
 */
export interface AgentToAgentConfig {
  /**
   * Explicit opt-in map.
   * Key: the agent making the call.
   * Value: list of agent names it may call (include own name for sub-agent).
   * Absent = no agent is permitted to call any other agent.
   */
  allowedTargets?: Record<string, string[]>;

  /**
   * Maximum nesting depth.  Default: 1.
   * 0 = all calls blocked regardless of allowedTargets.
   * 1 = agents may call agents; those sub-agents may not call further agents.
   */
  maxDepth?: number;
}

/**
 * Context injected by the gateway (or by tests).
 */
export interface AgentToAgentContext {
  /** Mutable ref — beige populates .current after AgentManager is created. */
  agentManagerRef?: { current: AgentManagerLike | null };
  sessionStore?: SessionStoreLike;
  beigeConfig?: BeigeConfigLike;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: { sessionKey?: string; channel?: string }
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
  return `a2a:${callerSessionKey}:${targetAgent}:${ts}`;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  target: string | null;
  session: string | null;
  messageFile: string | null;
  messageParts: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    target: null,
    session: null,
    messageFile: null,
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
// Usage text
// ---------------------------------------------------------------------------

function usageText(callerAgent: string, allowedTargets?: Record<string, string[]>): string {
  const permitted = allowedTargets?.[callerAgent]?.join(", ") ?? "(none configured)";
  return [
    "Usage: agent-to-agent --target <agent> [--session <key>] <message...>",
    "       agent-to-agent --target <agent> [--session <key>] --message-file <path>",
    "",
    "Start a new conversation:",
    "  agent-to-agent --target reviewer Please review the code in /workspace/src",
    "",
    "Continue an existing conversation:",
    "  agent-to-agent --target reviewer --session <key> Thanks, can you also check the tests?",
    "",
    `Targets you may call: ${permitted}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// createHandler — entry point called by the beige gateway at startup
// ---------------------------------------------------------------------------

export function createHandler(
  config: AgentToAgentConfig,
  context: AgentToAgentContext = {}
): ToolHandler {
  const { agentManagerRef, sessionStore, beigeConfig } = context;
  const maxDepth = config.maxDepth ?? 1;
  const allowedTargets = config.allowedTargets;

  return async (
    args: string[],
    _toolConfig?: Record<string, unknown>,
    sessionContext?: { sessionKey?: string; channel?: string }
  ): Promise<{ output: string; exitCode: number }> => {
    // ── Resolve live dependencies ──────────────────────────────────────────
    const agentManager = agentManagerRef?.current ?? null;
    if (!agentManager) {
      return {
        output: "agent-to-agent: gateway not ready (AgentManager unavailable). Try again in a moment.",
        exitCode: 1,
      };
    }

    // ── Parse args ─────────────────────────────────────────────────────────
    if (args.length === 0) {
      return {
        output: usageText("(unknown)", allowedTargets),
        exitCode: 1,
      };
    }

    const parsed = parseArgs(args);

    if (!parsed.target) {
      return {
        output: ["Error: --target <agent> is required.", "", usageText("(unknown)", allowedTargets)].join("\n"),
        exitCode: 1,
      };
    }

    // ── Identify the calling agent ─────────────────────────────────────────
    // The sessionKey encodes the channel and agent name, e.g. "tui:coder:default"
    // or "telegram:123:456".  We derive the agent name from the session store.
    const callerSessionKey = sessionContext?.sessionKey;
    const callerEntry = callerSessionKey ? sessionStore?.getEntry(callerSessionKey) : undefined;
    const callerAgent = callerEntry?.agentName ?? sessionContext?.channel ?? "unknown";

    // ── Depth check ────────────────────────────────────────────────────────
    const callerDepth = (callerEntry?.metadata?.depth as number | undefined) ?? 0;

    if (callerDepth >= maxDepth) {
      return {
        output: [
          `Error: Agent call depth limit reached (current depth: ${callerDepth}, max: ${maxDepth}).`,
          "This session was itself created by another agent and is not permitted to make",
          "further agent-to-agent calls.",
          "",
          "To allow deeper nesting, increase maxDepth in the agent-to-agent tool config.",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Permission check ───────────────────────────────────────────────────
    // allowedTargets absent → nothing is permitted (safe default).
    if (!allowedTargets) {
      return {
        output: [
          "Error: No allowedTargets configured for the agent-to-agent tool.",
          "Agent-to-agent calls are disabled until allowedTargets is set in config.json5.",
          "",
          "Example config:",
          "  config: {",
          `    allowedTargets: { "${callerAgent}": ["${parsed.target}"] }`,
          "  }",
        ].join("\n"),
        exitCode: 1,
      };
    }

    const permittedForCaller = allowedTargets[callerAgent] ?? [];
    if (!permittedForCaller.includes(parsed.target)) {
      const permitted = permittedForCaller.join(", ") || "(none)";
      return {
        output: [
          `Error: Agent '${callerAgent}' is not permitted to call agent '${parsed.target}'.`,
          `Permitted targets for '${callerAgent}': ${permitted}`,
          "",
          "Update allowedTargets in the agent-to-agent tool config to grant access.",
        ].join("\n"),
        exitCode: 1,
      };
    }

    // ── Validate target exists ─────────────────────────────────────────────
    if (beigeConfig && !beigeConfig.agents[parsed.target]) {
      const known = Object.keys(beigeConfig.agents).join(", ") || "(none)";
      return {
        output: [
          `Error: Unknown agent '${parsed.target}'.`,
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
        output: ["Error: No message provided.", "", usageText(callerAgent, allowedTargets)].join("\n"),
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
          output: "agent-to-agent: session store unavailable — cannot validate --session key.",
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
      if (existingEntry.agentName !== parsed.target) {
        return {
          output: [
            `Error: Session '${parsed.session}' belongs to agent '${existingEntry.agentName}',`,
            `but --target '${parsed.target}' was specified. Pass the correct agent name.`,
          ].join("\n"),
          exitCode: 1,
        };
      }
      childSessionKey = parsed.session;
    } else {
      // New session — generate a unique key and register it with depth metadata.
      childSessionKey = generateChildSessionKey(callerSessionKey ?? "unknown", parsed.target);
      if (sessionStore) {
        sessionStore.createSession(childSessionKey, parsed.target, {
          depth: callerDepth + 1,
          parentSessionKey: callerSessionKey ?? null,
          invokedBy: callerAgent,
        });
      }
    }

    // ── Invoke the target agent ────────────────────────────────────────────
    let response: string;
    try {
      response = await agentManager.prompt(childSessionKey, parsed.target, message);
    } catch (err) {
      return {
        output: [
          `Error: Agent '${parsed.target}' failed to respond.`,
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
