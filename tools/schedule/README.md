# Schedule Tool

A beige tool for creating and managing scheduled tasks that trigger agent prompts at specific times or intervals.

## Features

- **Cron-based scheduling**: Standard 5-field cron expressions
- **Persistent storage**: Schedules survive gateway restarts
- **Agent isolation**: Each agent can only see and manage its own schedules
- **Flexible control**: Enable, disable, or delete schedules at any time
- **Testing utility**: Preview next run times before creating a schedule

## Installation

Add to your beige configuration:

```json5
{
  tools: {
    schedule: {
      enabled: true,
      config: {
        maxSchedulesPerAgent: 100,
        defaultTimezone: "UTC"
      }
    }
  }
}
```

## Usage

### Create a Schedule

```sh
schedule create '0 9 * * *' 'Good morning! Time for daily review.'
```

### List Schedules

```sh
schedule list
```

Output:
```
3 schedules for agent 'beige':

  ✓ a1b2c3d4  0 9 * * *      2026-03-24 09:00
      "Good morning! Time for daily review."
  ✓ e5f6g7h8  */30 * * * *   2026-03-24 04:30
      "Check status"
  ✗ i9j0k1l2  0 0 * * 0      (disabled)
      "Weekly report"
```

### Show Schedule Details

```sh
schedule show a1b2c3d4
```

### Test a Cron Expression

```sh
schedule test '0 9 * * 1-5'
```

Output:
```
Cron expression: 0 9 * * 1-5

Next 5 runs:
  1. 2026-03-24 09:00
  2. 2026-03-25 09:00
  3. 2026-03-26 09:00
  4. 2026-03-27 09:00
  5. 2026-03-28 09:00
```

### Manage Schedules

```sh
# Temporarily disable
schedule disable a1b2c3d4

# Re-enable
schedule enable a1b2c3d4

# Delete permanently
schedule delete a1b2c3d4
```

## Cron Expression Format

Standard 5-field cron format:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
│ │ │ │ │
* * * * *
```

### Supported Syntax

| Syntax | Description | Example |
|--------|-------------|---------|
| `*` | Any value | `* * * * *` (every minute) |
| `n` | Specific value | `0 9 * * *` (9:00 AM daily) |
| `n-m` | Range | `0 9 * * 1-5` (9:00 AM weekdays) |
| `*/n` | Step | `*/15 * * * *` (every 15 minutes) |
| `a,b,c` | List | `0 9,12,18 * * *` (9 AM, noon, 6 PM) |

### Common Examples

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 0` | Every Sunday at midnight |
| `0 14 * * 1-5` | Weekdays at 2:00 PM |
| `0 9 1 * *` | First day of month at 9:00 AM |
| `0 9 1 1 *` | January 1st at 9:00 AM |

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSchedulesPerAgent` | number | 100 | Maximum schedules per agent |
| `defaultTimezone` | string | "UTC" | Timezone for cron evaluation |
| `storagePath` | string | `~/.beige/schedules.json` | Path to schedule storage file |

## Security

- **Agent isolation**: Agents can only see and manage their own schedules
- **Session binding**: Scheduled prompts run in the same session that created the schedule
- **Rate limiting**: Configurable maximum schedules per agent

## How It Works

1. **Tool side**: The `schedule` tool manages schedule entries in a JSON file
2. **Gateway side**: A scheduler service runs in the gateway and:
   - Loads schedules from storage
   - Checks every minute for due schedules
   - Triggers agent prompts via the AgentManager

## Requirements

- Beige gateway must be running for schedules to execute
- Schedules are tied to sessions; if a session is deleted, its schedules are orphaned

## Limitations

- **No second-level precision**: Minimum granularity is 1 minute
- **No year field**: Maximum recurrence is yearly
- **No timezone per schedule**: Uses gateway timezone (configurable globally)
- **Session required**: Schedules need a valid session key to trigger prompts

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| "Invalid cron expression" | Malformed expression | Use `schedule test` to validate |
| "Maximum schedules reached" | Hit limit (default: 100) | Delete unused schedules |
| "Schedule not found" | Wrong ID or not owned | Use `schedule list` to see IDs |
| "Agent identity unknown" | No BEIGE_AGENT_NAME | Update beige version |

## Future Enhancements

- [ ] One-time schedules (not recurring)
- [ ] Webhook-based schedules
- [ ] Schedule templates
- [ ] Per-schedule timezone
- [ ] Schedule history and logs
