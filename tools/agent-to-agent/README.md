# agent-to-agent

Invoke another beige agent and hold a multi-turn conversation with it. Every call returns the target agent's full response plus a **session key** you can pass back via `--session` to continue the same conversation.

Sub-agent calls (an agent calling itself) work identically — include the agent's own name in its `allowedTargets` list.

---

## Quick start

```sh
# Start a new conversation with the 'reviewer' agent
/tools/bin/agent-to-agent --target reviewer Please review the code in /workspace/src/main.ts

# The response looks like:
# SESSION: a2a:tui:coder:default:reviewer:20260317-213000-abc123
# ---
# <reviewer's response>

# Continue that exact conversation (same history, same context)
/tools/bin/agent-to-agent --target reviewer \
  --session a2a:tui:coder:default:reviewer:20260317-213000-abc123 \
  Thanks — can you also check the test coverage?

# Send a longer message from a file
/tools/bin/agent-to-agent --target reviewer \
  --session a2a:tui:coder:default:reviewer:20260317-213000-abc123 \
  --message-file /workspace/review-request.txt
```

---

## Output format

Every successful response begins with a `SESSION:` line, followed by `---`, followed by the target agent's reply:

```
SESSION: <session-key>
---
<target agent's full response>
```

Always save the session key. You will need it to ask follow-up questions.

---

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--target <agent>` | `-t` | **Required.** Name of the agent to invoke. Must be listed in `allowedTargets`. |
| `--session <key>` | `-s` | Resume an existing conversation. Omit to start a new session. |
| `--message-file <path>` | | Read the message body from a file instead of inline args. Useful for long prompts. |

Positional arguments after all flags are joined as the message.

---

## Session behaviour

- **Omitting `--session`** always creates a fresh session, even when calling the same target agent repeatedly. This means you can run two parallel conversations with the same agent and follow up with each independently.
- **Supplying `--session`** resumes that specific conversation thread. The target agent retains its full history and picks up exactly where it left off.
- Sessions created by this tool are normal beige sessions. They persist across gateway restarts and can be inspected in `~/.beige/sessions/`.

---

## Sub-agent calls

A sub-agent is simply an agent calling itself. There is no special mode — include the agent's own name in its `allowedTargets` list:

```json5
config: {
  allowedTargets: {
    coder: ["coder", "reviewer"],  // coder can spawn a sub-coder and call reviewer
  },
}
```

Sub-agents are subject to the same depth limit as cross-agent calls (see below).

---

## Depth limiting

Unconstrained nesting would allow runaway recursive agent calls. Depth is capped by `maxDepth` (default: `1`).

| `maxDepth` | What is allowed |
|---|---|
| `0` | No agent-to-agent calls at all, even if `allowedTargets` is set |
| `1` *(default)* | Agents may call agents; those sub-agents may **not** call further agents |
| `2` | Two levels of nesting; agents at depth 2 may not call further agents |

Depth is stored as metadata on the child session entry in beige's session map. Beige itself never interprets this metadata — it is fully owned by this tool.

When an agent at the depth limit tries to invoke another agent, it receives:

```
Error: Agent call depth limit reached (current depth: 1, max: 1).
This session was itself created by another agent and is not permitted to make
further agent-to-agent calls.

To allow deeper nesting, increase maxDepth in the agent-to-agent tool config.
```

---

## Configuration

Add the tool to `config.json5`:

```json5
tools: {
  "agent-to-agent": {
    path: "~/.beige/toolkits/matthias-hausberger-beige-toolkit/tools/agent-to-agent",
    target: "gateway",
    config: {
      // Which agents may call which other agents.
      // Absent entirely → no agent-to-agent calls are permitted.
      allowedTargets: {
        coder:    ["reviewer", "coder"],   // coder can call reviewer and itself
        reviewer: ["coder"],               // reviewer can call coder
      },

      // Maximum nesting depth. Default: 1.
      maxDepth: 1,
    },
  },
},

agents: {
  coder: {
    // ...
    tools: ["agent-to-agent"],
  },
  reviewer: {
    // ...
    tools: ["agent-to-agent"],
  },
},
```

Only agents that have `agent-to-agent` in their `tools` list can invoke the tool. The `allowedTargets` config then further restricts which of those agents may call which targets.

---

## Security model

| Concern | How it is handled |
|---|---|
| **Default deny** | No calls are permitted unless `allowedTargets` is explicitly configured. Installing the tool changes nothing until you opt in. |
| **Per-caller whitelisting** | Each calling agent has its own list of permitted targets. Agent A being allowed to call B does not imply B can call A. |
| **Depth cap** | `maxDepth` (default 1) prevents runaway recursive calls regardless of `allowedTargets`. |
| **Unknown targets** | If the named target does not exist in the beige config, the call is rejected immediately with a list of known agents. |
| **Session integrity** | Resuming a session with a mismatched `--target` is rejected. The session's recorded agent name must match. |

---

## Error reference

| Error | Cause |
|---|---|
| `--target <agent> is required` | No `--target` flag was provided |
| `No allowedTargets configured` | The config block has no `allowedTargets` key |
| `Agent 'X' is not permitted to call agent 'Y'` | The caller is not in `allowedTargets` or the target is not in the caller's list |
| `Agent call depth limit reached` | The calling session is already at `maxDepth` |
| `Unknown agent 'X'` | The target name is not defined in the beige config |
| `Session 'X' not found` | `--session` key does not exist in the session map |
| `Session 'X' belongs to agent 'Y'` | `--session` key exists but was created for a different agent than `--target` |
| `No message provided` | All of `<message>`, `--message-file` were absent or empty |
| `Could not read message file` | The path supplied to `--message-file` does not exist or is not readable |
| `gateway not ready` | The AgentManager is not yet initialised — retry after a moment |
