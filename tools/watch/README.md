# File Watcher Tool

Monitor files and directories for changes with the File Watcher tool.

## Overview

The File Watcher tool provides file system monitoring capabilities for beige agents. It can:
- Watch files and directories for create, modify, delete, and rename events
- Filter events by glob patterns
- Execute commands when changes are detected
- Track history of all file changes

## Installation

Add to your beige-toolkit configuration:

```json
{
  "tools": {
    "watch": {
      "path": "./tools/watch"
    }
  }
}
```

## Commands

### start

Start watching a path for changes.

```bash
# Watch a directory
watch start --path /workspace/project

# Watch with glob pattern
watch start --path /workspace/project --pattern "**/*.ts"

# Watch for specific events only
watch start --path /workspace/logs --events modify delete

# Execute command on change
watch start --path /workspace/data --commandOnEvent "echo '{file} was {event}d'"

# Non-recursive watch
watch start --path /workspace/config --recursive false

# With debounce (milliseconds)
watch start --path /workspace/build --debounce 500
```

**Parameters:**
- `path` (required): Path to watch
- `events`: Array of events to watch (`create`, `modify`, `delete`, `rename`)
- `pattern`: Glob pattern to filter files
- `commandOnEvent`: Command to execute on change (supports `{file}`, `{path}`, `{event}` placeholders)
- `debounce`: Debounce time in milliseconds (default: 100)
- `recursive`: Watch directories recursively (default: true)

**Returns:**
```json
{
  "success": true,
  "watcherId": "watch-1234567890-abc123"
}
```

### stop

Stop a specific watcher.

```bash
watch stop --watcherId watch-1234567890-abc123
```

**Parameters:**
- `watcherId` (required): ID of the watcher to stop

### list

List all active watchers.

```bash
watch list
```

**Returns:**
```json
{
  "watchers": [
    {
      "id": "watch-1234567890-abc123",
      "path": "/workspace/project",
      "events": ["create", "modify", "delete", "rename"],
      "pattern": "**/*.ts",
      "recursive": true,
      "startedAt": "2026-03-24T07:00:00.000Z"
    }
  ]
}
```

### clear

Stop all watchers.

```bash
watch clear
```

**Returns:**
```json
{
  "count": 3
}
```

### history

Show recent file change events.

```bash
# Last 50 events (default)
watch history

# Last 100 events
watch history --limit 100
```

**Returns:**
```json
{
  "events": [
    {
      "timestamp": "2026-03-24T07:01:23.456Z",
      "watcherId": "watch-1234567890-abc123",
      "event": "modify",
      "path": "/workspace/project/src/index.ts",
      "file": "index.ts"
    }
  ]
}
```

## Configuration

The tool can be configured with security limits:

```json
{
  "config": {
    "allowPaths": ["/workspace/**"],
    "denyPaths": ["/workspace/secrets/**", "**/.env*"],
    "maxWatchers": 10,
    "maxHistorySize": 1000,
    "defaultDebounce": 100
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowPaths` | string[] | all | Glob patterns for paths that can be watched |
| `denyPaths` | string[] | none | Glob patterns for paths that cannot be watched |
| `maxWatchers` | number | 10 | Maximum concurrent watchers |
| `maxHistorySize` | number | 1000 | Maximum events to keep in history |
| `defaultDebounce` | number | 100 | Default debounce time in ms |

## Use Cases

### Development Workflow

Watch source files and run tests on changes:

```bash
watch start --path /workspace/src --pattern "**/*.ts" \
  --commandOnEvent "bun test" --debounce 1000
```

### Log Monitoring

Watch log files for new entries:

```bash
watch start --path /workspace/logs --pattern "*.log" \
  --events modify --commandOnEvent "tail -1 {path}"
```

### Build Triggers

Watch for file changes and trigger builds:

```bash
watch start --path /workspace/src --events create modify delete \
  --commandOnEvent "bun run build" --debounce 2000
```

### Data Pipeline

Watch for new data files:

```bash
watch start --path /workspace/inbox --events create \
  --commandOnEvent "process-data {path}"
```

## Security

### Path Restrictions

Use `allowPaths` and `denyPaths` to restrict which paths can be watched:

```json
{
  "config": {
    "allowPaths": ["/workspace/projects/**"],
    "denyPaths": ["/workspace/projects/secrets/**"]
  }
}
```

### Resource Limits

- `maxWatchers` prevents resource exhaustion
- `maxHistorySize` limits memory usage
- Debouncing prevents command flooding

## Event Types

| Event | Description |
|-------|-------------|
| `create` | New file or directory created |
| `modify` | Existing file modified |
| `delete` | File or directory deleted |
| `rename` | File or directory renamed (reported as create/delete) |

## Notes

- Uses Node.js `fs.watch` under the hood
- Recursive watching uses the `recursive` option (may not work on all platforms)
- Debouncing helps handle rapid successive changes
- Command execution is asynchronous and won't block other events
