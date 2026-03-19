# Agent-to-Agent Tool — Usage Guide

Invoke another beige agent and hold a multi-turn conversation with it. Each call returns the target agent's full response plus a **session key** you can pass back to continue the same conversation.

## Calling Convention

```sh
/tools/bin/agent-to-agent --target <agent> <message...>
/tools/bin/agent-to-agent --target <agent> --session <key> <message...>
/tools/bin/agent-to-agent --info
```

## Check Your Permissions First

Always start by checking what you're allowed to do:

```sh
/tools/bin/agent-to-agent --info
```

This shows your current agent name, depth, allowed targets, and whether you can make calls. It never invokes any agent.

## Examples

### Start a New Conversation

```sh
/tools/bin/agent-to-agent --target reviewer Please review the code in /workspace/src/main.ts
```

Response format:
```
SESSION: a2a:tui:coder:default:reviewer:20260317-213000-abc123
---
<reviewer's response>
```

**Always save the session key** — you need it for follow-ups.

### Continue a Conversation

```sh
/tools/bin/agent-to-agent --target reviewer \
  --session a2a:tui:coder:default:reviewer:20260317-213000-abc123 \
  Thanks — can you also check the test coverage?
```

### Send a Long Message from a File

```sh
/tools/bin/agent-to-agent --target reviewer \
  --session a2a:tui:coder:default:reviewer:20260317-213000-abc123 \
  --message-file /workspace/review-request.txt
```

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--target <agent>` | `-t` | Agent to invoke. Required unless `--info`. |
| `--session <key>` | `-s` | Resume an existing conversation. Omit to start new. |
| `--message-file <path>` | | Read message from a file instead of inline args. |
| `--info` | `-i` | Print permission summary and exit. |

Positional arguments after flags are joined as the message.

## Session Behaviour

- **Omitting `--session`** always creates a fresh session, even when calling the same target repeatedly. You can run parallel conversations with the same agent.
- **Supplying `--session`** resumes that specific conversation thread with full history.
- Sessions persist across gateway restarts.

## Depth Limiting

Nesting is capped by `maxDepth` (default: `1`):

| `maxDepth` | What is allowed |
|---|---|
| `0` | No agent-to-agent calls at all |
| `1` *(default)* | Agents may call agents; those sub-agents may **not** call further agents |
| `2` | Two levels of nesting |

If you hit the depth limit:
```
Error: Agent call depth limit reached (current depth: 1, max: 1).
```

## Tips

- Run `--info` first to understand your permissions before making calls.
- Omitting `--session` starts a fresh conversation every time.
- Use `--message-file` for long or complex prompts that would be awkward inline.
- Sub-agent calls (calling yourself) work the same way — your name just needs to be in `allowedTargets`.
