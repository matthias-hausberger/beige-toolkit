# Schedule Tool — Usage Guide

Create and manage scheduled tasks that trigger back to you. You can schedule a one-off prompt, a recurring cron-based prompt, or a shell command on the gateway host. The schedule always fires back to the agent that created it — you cannot target other agents.

## Calling Convention

```sh
/tools/bin/schedule <subcommand> [args...]
```

## Creating Schedules

### One-off prompt

```sh
/tools/bin/schedule create --once 2026-03-28T09:00:00Z \
  --prompt "Check the build status and summarise any failures."
```

### One-off prompt from a file

Write a long prompt to a workspace file first, then reference it:

```sh
/tools/bin/schedule create --once 2026-03-28T09:00:00Z \
  --message-file /workspace/prompts/build-check.md
```

The file is read at trigger time — you can update it after creating the schedule.

### Recurring cron prompt

```sh
/tools/bin/schedule create --cron "0 9 * * 1-5" --tz "Europe/Vienna" \
  --prompt "Good morning. Please summarise my GitHub notifications."
```

### Recurring prompt from a file

```sh
/tools/bin/schedule create --cron "0 9 * * 1-5" --tz "Europe/Vienna" \
  --message-file /workspace/prompts/morning-briefing.md \
  --label "Morning briefing"
```

### Recurring shell command (requires allowExec: true)

```sh
/tools/bin/schedule create --cron "0 * * * *" \
  --exec "node /workspace/scripts/sync-data.mjs"
```

### Optional flags for create

```sh
--label "My label"            # human-readable name shown in list output
--max-runs 5                  # stop the cron after 5 runs
--expires 2027-01-01T00:00:00Z  # stop the cron after this datetime
```

## Listing and Inspecting

```sh
# List your active schedules (default)
/tools/bin/schedule list

# List all schedules regardless of status
/tools/bin/schedule list --status all

# Filter by status
/tools/bin/schedule list --status paused
/tools/bin/schedule list --status completed

# Machine-readable output
/tools/bin/schedule list --format json

# Full details for one schedule
/tools/bin/schedule get sched_a1b2c3
```

## Managing Schedules

```sh
# Cancel a schedule permanently
/tools/bin/schedule cancel sched_a1b2c3

# Pause a cron schedule (keeps nextRun; won't fire while paused)
/tools/bin/schedule pause sched_a1b2c3

# Resume a paused schedule (re-computes nextRun from now)
/tools/bin/schedule resume sched_a1b2c3
```

## Viewing Run History

```sh
# Show the last 20 runs (default)
/tools/bin/schedule history sched_a1b2c3

# Limit output
/tools/bin/schedule history sched_a1b2c3 --limit 5

# Machine-readable output
/tools/bin/schedule history sched_a1b2c3 --format json
```

## Testing a Schedule

Trigger a schedule immediately without changing its state — `runCount`, `status`, and `nextRun` are all preserved. Use this to verify your prompt or script works before the real trigger fires.

```sh
/tools/bin/schedule test sched_a1b2c3
```

## Flags Reference

| Flag | Applies to | Description |
|---|---|---|
| `--once <ISO8601>` | `create` | Fire once at this datetime (UTC). |
| `--cron <expr>` | `create` | Fire on a cron schedule (5-field standard). |
| `--tz <tz>` | `create` | IANA timezone for cron (default: `UTC`). |
| `--prompt <message...>` | `create` | Inline message sent to yourself at trigger time. |
| `--message-file <path>` | `create` | Path to a file whose content is used as the message. |
| `--exec <command>` | `create` | Shell command to run on the gateway host. |
| `--label <text>` | `create` | Human-readable label for the schedule. |
| `--max-runs <n>` | `create` | Stop cron after N runs. |
| `--expires <ISO8601>` | `create` | Stop cron after this datetime. |
| `--status <s>` | `list` | Filter by status: `active`, `paused`, `completed`, `all`. Default: `active`. |
| `--limit <n>` | `history` | Number of run records to show. Default: `20`. |
| `--format json` | `list`, `history` | Machine-readable JSON output. |

## Cron Expression Quick Reference

| Expression | Meaning |
|---|---|
| `0 9 * * 1-5` | 9:00 am every weekday |
| `0 */2 * * *` | Every 2 hours |
| `0 9 * * 1` | Every Monday at 9:00 am |
| `30 18 * * 5` | Every Friday at 6:30 pm |
| `0 0 1 * *` | First day of every month at midnight |

All times are interpreted in UTC unless `--tz` is provided.

## Tips

- Use `--message-file` for prompts you want to update without recreating the schedule.
- Each triggered run starts a fresh session — there is no shared context between runs.
- Use `test` before relying on a new schedule to confirm it behaves as expected.
- Check `list --status all` to audit completed or cancelled schedules.
- `pause` / `resume` is only meaningful for cron schedules — one-off schedules complete immediately after firing.
