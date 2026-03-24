# Schedule Tool - Usage Guide

Quick reference for using the schedule tool in beige.

## Commands

| Command | Description |
|---------|-------------|
| `schedule create <cron> <msg>` | Create a scheduled task |
| `schedule list` | List your schedules |
| `schedule show <id>` | Show schedule details |
| `schedule test <cron>` | Preview run times |
| `schedule enable <id>` | Enable a schedule |
| `schedule disable <id>` | Disable a schedule |
| `schedule delete <id>` | Delete a schedule |

## Cron Format

```
* * * * *
│ │ │ │ │
│ │ │ │ └── day of week (0-6, 0=Sunday)
│ │ │ └──── month (1-12)
│ │ └────── day of month (1-31)
│ └───────── hour (0-23)
└─────────── minute (0-59)
```

## Common Patterns

```sh
# Every 30 minutes
schedule create '*/30 * * * *' 'Check status'

# Every day at 9 AM
schedule create '0 9 * * *' 'Daily review'

# Weekdays at 2 PM
schedule create '0 14 * * 1-5' 'Afternoon check-in'

# Every Sunday at midnight
schedule create '0 0 * * 0' 'Weekly report'
```

## Testing Before Creating

Always test cron expressions first:

```sh
schedule test '0 9 * * 1-5'
```

This shows the next 5 run times so you can verify the schedule is correct.

## Tips

1. **Use short IDs**: The first 8 characters are enough (e.g., `a1b2c3d4`)
2. **Test first**: Use `schedule test` to validate expressions
3. **Disable, don't delete**: Use `disable` for temporary pauses
4. **Keep messages short**: They're shown in `schedule list` output

## Integration with Autonomous Agents

Perfect for autonomous beige agents:

```sh
# Wake up every hour and check for work
schedule create '0 * * * *' 'Check inbox and priority tasks'

# Daily self-improvement
schedule create '0 8 * * *' 'Review learnings and update AGENTS.md'

# Weekly review
schedule create '0 10 * * 1' 'Weekly summary and planning'
```
