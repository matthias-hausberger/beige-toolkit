# Spawn Tool — Usage Guide

Spawn another beige agent (or a sub-agent of yourself) and hold a multi-turn conversation with it. Each call returns the target agent's full response plus a **session key** you can pass back to continue the same conversation.

## Calling Convention

```sh
/tools/bin/spawn --target <agent> <message...>
/tools/bin/spawn --target <agent> --session <key> <message...>
/tools/bin/spawn --info
```

## Check Your Permissions First

Always start by checking what you're allowed to do:

```sh
/tools/bin/spawn --info
```

This shows your current agent name, depth, allowed targets, and whether you can spawn agents. It never invokes any agent.

## Examples

### Start a New Conversation

```sh
/tools/bin/spawn --target reviewer Please review the code in /workspace/src/main.ts
```

Response format:
```
SESSION: spawn:tui:coder:default:reviewer:20260317-213000-abc123
---
<reviewer's response>
```

**Always save the session key** — you need it for follow-ups.

### Continue a Conversation

```sh
/tools/bin/spawn --target reviewer \
  --session spawn:tui:coder:default:reviewer:20260317-213000-abc123 \
  Thanks — can you also check the test coverage?
```

### Send a Long Message from a File

```sh
/tools/bin/spawn --target reviewer \
  --session spawn:tui:coder:default:reviewer:20260317-213000-abc123 \
  --message-file /workspace/review-request.txt
```

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--target <agent>` | `-t` | Agent to spawn. Required unless `--info`. |
| `--session <key>` | `-s` | Resume an existing conversation. Omit to start new. |
| `--message-file <path>` | | Read message from a file instead of inline args. |
| `--info` | `-i` | Print permission summary and exit. |

Positional arguments after flags are joined as the message.

## Session Behaviour

- **Omitting `--session`** always creates a fresh session, even when calling the same target repeatedly. You can run parallel conversations with the same agent.
- **Supplying `--session`** resumes that specific conversation thread with full history.
- Sessions persist across gateway restarts.

## Depth Limiting

Nesting is capped by `maxDepth` (default: `1`). Each target can have its own depth limit:

| `maxDepth` | What is allowed |
|---|---|
| `0` | No spawns at all to this target |
| `1` *(default)* | Agents may spawn agents; those sub-agents may **not** spawn further agents |
| `2` | Two levels of nesting |

If you hit the depth limit:
```
Error: Agent call depth limit reached (current depth: 1, max for 'reviewer': 1).
```

## Tips

- Run `--info` first to understand your permissions before spawning agents.
- Omitting `--session` starts a fresh conversation every time.
- Use `--message-file` for long or complex prompts that would be awkward inline.
- Sub-agent spawns (spawning yourself) work the same way — if `SELF` or your own agent name is in the `targets` config.
