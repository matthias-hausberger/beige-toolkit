# Slack Tool — Usage Guide

Interact with Slack workspaces. All arguments are passed to `slackcli` on the gateway host. The tool enforces a permission layer before executing any command.

## Calling Convention

```sh
/tools/bin/slack <subcommand> [args...]
```

## Examples

### List Conversations

```sh
# List channels and DMs
/tools/bin/slack conversations list

# List only public channels, exclude archived
/tools/bin/slack conversations list --types public_channel --exclude-archived

# Limit results
/tools/bin/slack conversations list --limit 20
```

### Read Messages

```sh
# Read recent messages from a channel
/tools/bin/slack conversations read C1234567890 --limit 20

# Read a specific thread
/tools/bin/slack conversations read C1234567890 --thread-ts 1234567890.123

# JSON output for scripting
/tools/bin/slack conversations read C1234567890 --json
```

### Send Messages

```sh
# Send a message (if permitted)
/tools/bin/slack messages send --recipient-id C1234567890 --message "Deploy complete ✓"

# Reply in a thread
/tools/bin/slack messages send --recipient-id C1234567890 --thread-ts 1234567890.123 --message "Done!"

# Draft a message
/tools/bin/slack messages draft --recipient-id C1234567890 --message "Draft for review"
```

### Reactions

```sh
# Add a reaction
/tools/bin/slack messages react --channel-id C1234567890 --timestamp 1234567890.123 --emoji thumbsup
```

### Authentication / Workspaces

```sh
# List authenticated workspaces
/tools/bin/slack auth list

# Set default workspace
/tools/bin/slack auth set-default T1234567890
```

## Understanding Command Paths

Your permissions are based on **command paths** — the leading 1–2 subcommand tokens:

| Args | Command path |
|---|---|
| `conversations list --limit 50` | `conversations list` |
| `messages send --recipient-id C1` | `messages send` |
| `messages react ...` | `messages react` |
| `auth login` | `auth login` |

If a command is denied, you'll see an error like:

```
Permission denied: command 'messages send' is blocked by denyCommands
```

## Workspace Injection

If a default workspace is configured, `--workspace` is automatically appended to your calls when you don't specify one. You can always override by passing `--workspace` explicitly.

## Tips

- Always specify `--limit` when listing conversations or reading messages to avoid huge responses.
- Use `--json` flag for structured output suitable for scripting.
- Run `slack <subcommand> --help` for full flag reference.
- The tool is stateless — each invocation spawns a fresh `slackcli` process.
