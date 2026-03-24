# File Watcher Tool - Usage Guide

Quick reference for using the watch tool in beige agents.

## Common Commands

### Start Watching

```bash
# Watch a directory for all changes
watch start --path /workspace/src

# Watch only TypeScript files
watch start --path /workspace/src --pattern "*.ts"

# Watch for new files only
watch start --path /workspace/inbox --events '["create"]'

# Run command on change
watch start --path /workspace/src --command "pnpm test"
```

### Manage Watchers

```bash
# List active watchers
watch list

# Stop a specific watcher
watch stop --id watch-1

# Stop all watchers
watch clear
```

### View History

```bash
# Recent events
watch history

# Events for specific watcher
watch history --id watch-1

# More events
watch history --limit 50
```

## Use Cases for Agents

### Monitor Inbox

```bash
# Watch for new tasks
watch start --path /workspace/inbox --events '["create"]' --name "inbox-monitor"
```

### Auto-Process Files

```bash
# Process new files automatically
watch start --path /workspace/media/inbound --events '["create"]' \
  --command "node /workspace/scripts/process-media.js {file}"
```

### Development Workflow

```bash
# Auto-run tests during development
watch start --path /workspace/repos/beige-toolkit/tools --pattern "*.ts" \
  --command "cd /workspace/repos/beige-toolkit && pnpm test"
```

## Tips

1. **Use names**: Give watchers names for easy identification
2. **Filter events**: Only watch events you care about
3. **Use patterns**: Filter files to reduce noise
4. **Set debounce**: Increase debounce for files that change rapidly
5. **Check history**: Use `watch history` to see what's been happening

## Example: Complete Workflow

```bash
# 1. Start watching
watch start --path /workspace/inbox --events '["create"]' --name "inbox"

# 2. Check it's running
watch list

# 3. When a new file arrives, check history
watch history --id watch-1

# 4. Stop when done
watch stop --id watch-1
```

## Error Handling

The tool will fail with clear error messages:
- `Path does not exist` - The specified path doesn't exist
- `Path not allowed` - Path is outside allowed directories
- `Maximum watchers reached` - Stop some watchers first
- `Watcher not found` - Invalid watcher ID

## Integration with Agents

Agents can use the watch tool to:
- React to new files automatically
- Monitor log files for errors
- Trigger builds or tests on code changes
- Process uploaded media files
- Watch for configuration changes
