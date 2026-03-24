# Notify Tool - Usage Guide

Quick reference for the notify tool.

## Quick Start

```sh
# Simple notification
notify -m "Hello from your agent!"

# With title and priority
notify -m "Build failed" -T "CI Alert" -p high
```

## Common Use Cases

### Task Completion
```sh
notify -m "Long task finished successfully" -T "Task Complete"
```

### Error Alert
```sh
notify -m "Error in data pipeline" -p high --emoji warning
```

### Status Update with Link
```sh
notify -m "Results available" -c "https://example.com/results"
```

### Delayed Reminder
```sh
notify -m "Check on the job" -d "1h"
```

## Configuration

Set in `~/.beige/config.json`:

```json
{
  "tools": {
    "notify": {
      "defaultTopic": "my-topic"
    }
  }
}
```

## Options

| Option | Example |
|--------|---------|
| `-m, --message` | `-m "Hello"` |
| `-t, --topic` | `-t alerts` |
| `-T, --title` | `-T "Alert"` |
| `-p, --priority` | `-p high` |
| `--tags` | `--tags warning,build` |
| `-e, --emoji` | `-e bell` |
| `-c, --click` | `-c https://example.com` |
| `-d, --delay` | `-d 30min` |

## Priority Values

- `min` / `5` - Lowest priority
- `low` / `4` - Low priority
- `default` / `3` - Normal (default)
- `high` / `2` - High priority
- `urgent` / `1` - Highest priority

## Notes

- Requires ntfy.sh app installed on device
- Topic must be subscribed to receive notifications
- Free service, no signup required
- Can self-host ntfy server
