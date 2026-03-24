# Process Tool Usage Guide

Quick reference for using the process tool effectively.

## Basic Usage

### List All Processes
```bash
process list
```

### Find a Process
```bash
process find --name node
```

### Kill a Process
```bash
process kill --pid 1234
```

### Monitor a Process
```bash
process monitor --pid 1234 --duration 10
```

## Common Tasks

### Find High CPU Processes
```bash
process top --by cpu --limit 10
```

### Find High Memory Processes
```bash
process top --by mem --limit 10
```

### Kill a Stuck Process
```bash
# Try graceful first
process kill --pid 1234

# If it doesn't respond, force it
process kill --pid 1234 --force
```

### Kill Process Tree
```bash
# Kill a process and all its children
process kill --pid 1234 --children
```

### Find Processes by User
```bash
process list --user www-data
```

### View Process Tree
```bash
process tree --pid 1
```

## Tips

1. **Use --limit** to avoid overwhelming output
2. **Use --format json** for programmatic processing
3. **Use --sort cpu** to find resource hogs
4. **Use --children** when killing spawned processes
5. **Monitor before killing** to confirm correct PID

## Signals

- **SIGTERM** (default) - Ask nicely to terminate
- **SIGKILL** (force) - Force immediate termination
- **SIGINT** - Interrupt (like Ctrl+C)
- **SIGSTOP** - Pause process
- **SIGCONT** - Resume process

## Safety

- Always verify PID before killing
- Check process tree to understand dependencies
- Use SIGTERM before SIGKILL
- Be careful with `--children` flag
