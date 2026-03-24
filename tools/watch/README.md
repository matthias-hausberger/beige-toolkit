# File Watcher Tool

Watch files and directories for changes with flexible configuration.

## Overview

The watch tool monitors files and directories for changes, creations, and deletions. It supports:
- Glob patterns for filtering
- Event-specific watching
- Command execution on changes
- Debouncing to prevent duplicate events
- Event history tracking

## Installation

```bash
# Add to your beige-toolkit tools directory
cp -r tools/watch /path/to/beige-toolkit/tools/
```

## Commands

### start

Start watching a file or directory.

```bash
watch start --path /workspace/src --pattern "*.ts"
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to file or directory to watch |
| `events` | array | No | Events to watch: `change`, `create`, `delete` (default: all) |
| `recursive` | boolean | No | Watch directories recursively (default: true) |
| `pattern` | string | No | Glob pattern to filter files (e.g., `*.ts`) |
| `command` | string | No | Command to run on change |
| `debounce` | number | No | Debounce time in ms (default: 100) |
| `name` | string | No | Name for this watcher (for reference) |

**Command Placeholders:**

When using `--command`, you can use these placeholders:
- `{file}` - Path to the changed file
- `{event}` - Event type (change, create, delete)
- `{watcher}` - Watcher ID

**Example:**

```bash
# Watch TypeScript files and run tests on change
watch start --path /workspace/src --pattern "*.ts" --command "pnpm test"

# Watch for new files only
watch start --path /workspace/inbox --events '["create"]'

# Watch with name for easy reference
watch start --path /workspace/logs --name "log-watcher"
```

### stop

Stop a specific watcher.

```bash
watch stop --id watch-1
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Watcher ID to stop |

### list

List all active watchers.

```bash
watch list
```

**Output:**

```json
{
  "success": true,
  "watchers": [
    {
      "id": "watch-1",
      "name": "log-watcher",
      "path": "/workspace/logs",
      "events": ["change", "create", "delete"],
      "recursive": true,
      "startedAt": "2026-03-24T06:30:00Z",
      "eventCount": 5
    }
  ],
  "count": 1
}
```

### clear

Stop all watchers.

```bash
watch clear
```

### history

Show recent file change events.

```bash
watch history --limit 50
watch history --id watch-1 --limit 10
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Filter by watcher ID |
| `limit` | number | No | Number of events to show (default: 20) |

## Configuration

Configure the watch tool in your agent config:

```json
{
  "tools": {
    "watch": {
      "maxWatchers": 10,
      "maxHistory": 100,
      "allowPaths": ["/workspace"],
      "denyPaths": ["/workspace/secrets"]
    }
  }
}
```

**Config Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxWatchers` | number | 10 | Maximum concurrent watchers |
| `maxHistory` | number | 100 | Maximum events to keep in history |
| `allowPaths` | string[] | [workspace] | Allowed path patterns |
| `denyPaths` | string[] | [] | Denied path patterns |

## Use Cases

### Development

```bash
# Auto-run tests on file change
watch start --path src --pattern "*.ts" --command "pnpm test {file}"

# Auto-format on save
watch start --path src --command "prettier --write {file}"
```

### Monitoring

```bash
# Monitor log files
watch start --path /var/log/app --events '["create"]' --name "log-monitor"

# Watch inbox directory
watch start --path /workspace/inbox --events '["create"]'
```

### Automation

```bash
# Trigger build on source change
watch start --path src --command "pnpm build"

# Sync files on change
watch start --path data --command "rsync -av {file} backup/"
```

## Event Types

| Event | Description |
|-------|-------------|
| `change` | File content modified |
| `create` | New file created |
| `delete` | File deleted |

## Glob Patterns

The pattern parameter supports basic glob syntax:

| Pattern | Matches |
|---------|---------|
| `*.ts` | All .ts files |
| `src/**/*.ts` | All .ts files in src/ and subdirectories |
| `test-*.js` | Files starting with test- |
| `*.{ts,js}` | All .ts and .js files |

## Security

The watch tool has built-in security:
- Path allow/deny lists prevent unauthorized access
- Maximum watcher limit prevents resource exhaustion
- Commands run with a 30-second timeout
- Only workspace paths are allowed by default

## Implementation Details

- Uses Node.js `fs.watch()` with recursive option
- Debouncing prevents duplicate events for rapid changes
- Event history is kept in memory (up to `maxHistory` events)
- Each watcher gets a unique ID for management

## Limitations

- Recursive watching on Linux requires Node.js 19+
- Command execution is blocking (use short commands)
- Large directories may have performance impact
- Event history is lost on process restart
