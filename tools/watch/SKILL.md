# File Watcher Tool Usage Guide

## Quick Start

```bash
# Start watching a directory
/tools/bin/watch start --path /workspace/project

# List active watchers
/tools/bin/watch list

# View recent changes
/tools/bin/watch history

# Stop a watcher
/tools/bin/watch stop --watcherId <id>

# Stop all watchers
/tools/bin/watch clear
```

## Common Patterns

### Watch TypeScript files

```bash
/tools/bin/watch start --path /workspace/src --pattern "**/*.ts"
```

### Run tests on changes

```bash
/tools/bin/watch start --path /workspace/src --pattern "**/*.ts" \
  --commandOnEvent "bun test" --debounce 1000
```

### Monitor logs

```bash
/tools/bin/watch start --path /workspace/logs --pattern "*.log" \
  --events modify
```

### Watch for new files only

```bash
/tools/bin/watch start --path /workspace/inbox --events create
```

## Command Placeholders

When using `--commandOnEvent`, these placeholders are replaced:

| Placeholder | Replaced With |
|-------------|---------------|
| `{file}` | Filename (e.g., `index.ts`) |
| `{path}` | Full path (e.g., `/workspace/src/index.ts`) |
| `{event}` | Event type (e.g., `modify`) |

## Best Practices

1. **Use patterns** to filter noise (e.g., `--pattern "**/*.ts"`)
2. **Add debounce** for commands that take time (e.g., `--debounce 1000`)
3. **Limit events** to what you need (e.g., `--events modify`)
4. **Clean up** watchers when done (`watch clear`)

## Troubleshooting

### Too many events

Add a more specific pattern or increase debounce:

```bash
/tools/bin/watch start --path /workspace --pattern "src/**/*.ts" --debounce 500
```

### Commands not running

Check that the command works standalone first:

```bash
# Test the command directly
bun test

# Then add to watcher
/tools/bin/watch start --path /workspace --commandOnEvent "bun test"
```

### Watcher limit reached

Clear unused watchers:

```bash
/tools/bin/watch list
/tools/bin/watch clear
```
