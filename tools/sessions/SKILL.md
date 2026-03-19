# Sessions Tool — Usage Guide

Browse and search your own conversation history. You can only access your own sessions — cross-agent access is not permitted.

## Calling Convention

```sh
/tools/bin/sessions <subcommand> [args...]
```

## Examples

### List Sessions

```sh
# List your sessions (newest first)
/tools/bin/sessions list

# Include the currently running session
/tools/bin/sessions list --include-active

# Machine-readable output
/tools/bin/sessions list --format json
```

### Read a Session

```sh
# Show full message history
/tools/bin/sessions get tui:coder:default

# Show all messages (long sessions are truncated by default at 50 messages)
/tools/bin/sessions get tui:coder:default --all

# Machine-readable output
/tools/bin/sessions get tui:coder:default --format json
```

Tool calls within assistant messages are shown as `[tool: name]` inline. Tool results appear as separate `tool` role messages.

### Search Across Sessions

```sh
# Search message content (case-insensitive substring match)
/tools/bin/sessions grep "auth module"

# Use regex
/tools/bin/sessions grep /TypeError/

# Search within one session only
/tools/bin/sessions grep "refactor" --session tui:coder:s1

# Search fewer sessions (default: 100 newest)
/tools/bin/sessions grep "bug" --max-sessions 20

# Collect more matches (default: 50)
/tools/bin/sessions grep "TODO" --max-matches 100

# Machine-readable output
/tools/bin/sessions grep "deploy" --format json
```

**Pattern syntax:**
- Plain string → case-insensitive substring match: `sessions grep "auth module"`
- `/regex/flags` → regular expression: `sessions grep /TypeError/i`

## Flags Reference

| Flag | Applies to | Default | Description |
|---|---|---|---|
| `--include-active` | `list` | off | Include the currently running session |
| `--all` | `get` | off | Show all messages; disable truncation |
| `--session <key>` | `grep` | — | Search within one session only |
| `--max-sessions <n>` | `grep` | `100` | Maximum sessions to search (newest first) |
| `--max-matches <n>` | `grep` | `50` | Stop after N total matches |
| `--format json` | all | text | Machine-readable JSON output |

## Tips

- Use `list` first to discover session keys, then `get` to read them.
- Use `grep` to find specific conversations or decisions from past sessions.
- Tool-initiated sessions (sub-agent calls) are excluded from `list` by default.
- Sessions persist across gateway restarts.
