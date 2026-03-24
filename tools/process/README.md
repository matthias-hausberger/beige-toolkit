# Process Tool

List, monitor, and manage processes with this tool. Provides functionality similar to `ps`, `kill`, `top`, and process monitoring utilities.

## Features

- **List processes** - View all running processes with filtering and sorting
- **Find processes** - Search by name, user, or command pattern
- **Kill processes** - Terminate processes with various signals
- **Monitor processes** - Track CPU, memory, and I/O over time
- **Process tree** - View hierarchical process relationships
- **Top processes** - Identify resource-intensive processes

## Installation

```bash
pnpm install
```

## Usage

### List Processes

```bash
# List all processes
process list

# Filter by name
process list --filter node

# Filter by user
process list --user root

# Sort by CPU usage
process list --sort cpu --limit 10

# JSON output
process list --format json
```

### Find Processes

```bash
# Find by name
process find --name chrome

# Find by command pattern
process find --cmd "webpack"

# Exact match
process find --name node --exact

# Combine filters
process find --user root --name systemd
```

### Kill Processes

```bash
# Graceful termination
process kill --pid 1234

# Force kill
process kill --pid 1234 --force

# Kill with specific signal
process kill --pid 1234 --signal SIGTERM

# Kill process tree
process kill --pid 1234 --children
```

### Monitor Processes

```bash
# Monitor specific process
process monitor --pid 1234

# Monitor for 30 seconds
process monitor --pid 1234 --duration 30

# Custom interval
process monitor --pid 1234 --interval 2 --duration 20

# Monitor system-wide
process monitor --metrics cpu mem

# Monitor specific metrics
process monitor --pid 1234 --metrics cpu mem io
```

### Process Tree

```bash
# Show all process trees
process tree

# Show tree from specific PID
process tree --pid 1

# Filter by user
process tree --user node
```

### Top Processes

```bash
# Top CPU consumers
process top --by cpu --limit 10

# Top memory consumers
process top --by mem --limit 20

# Continuous monitoring
process top --by cpu --interval 2 --count 5
```

## Commands

| Command | Description |
|---------|-------------|
| `list` / `ps` | List running processes |
| `find` | Search for processes |
| `kill` | Terminate a process |
| `monitor` | Track process metrics |
| `tree` | Show process hierarchy |
| `top` | Show top resource consumers |

## Options

### list / ps

| Option | Type | Description |
|--------|------|-------------|
| `--filter` | string | Filter by name or command |
| `--user` | string | Filter by user |
| `--name` | string | Filter by process name |
| `--sort` | enum | Sort by: pid, cpu, mem, name, time |
| `--limit` | number | Limit results (1-1000) |
| `--tree` | boolean | Show process tree |
| `--format` | enum | Output format: json, table |

### kill

| Option | Type | Description |
|--------|------|-------------|
| `--pid` | number | Process ID (required) |
| `--signal` | enum | Signal: SIGTERM, SIGKILL, SIGINT, SIGSTOP, SIGCONT |
| `--force` | boolean | Use SIGKILL |
| `--children` | boolean | Also kill child processes |

### monitor

| Option | Type | Description |
|--------|------|-------------|
| `--pid` | number | Process ID to monitor |
| `--interval` | number | Sampling interval (1-60s) |
| `--duration` | number | Duration (1-300s) |
| `--metrics` | array | Metrics: cpu, mem, io |

### find

| Option | Type | Description |
|--------|------|-------------|
| `--name` | string | Process name pattern |
| `--user` | string | Filter by user |
| `--cmd` | string | Command pattern |
| `--exact` | boolean | Exact match |
| `--limit` | number | Limit results (1-1000) |

### tree

| Option | Type | Description |
|--------|------|-------------|
| `--pid` | number | Root PID |
| `--user` | string | Filter by user |
| `--format` | enum | Output format: json, tree |

### top

| Option | Type | Description |
|--------|------|-------------|
| `--by` | enum | Sort by: cpu, mem |
| `--limit` | number | Number to show (1-100) |
| `--interval` | number | Refresh interval (1-10s) |
| `--count` | number | Number of updates (1-100) |

## Configuration

The tool can be configured with these options:

```json
{
  "allowKill": true,
  "denyUsers": ["root", "system"],
  "maxResults": 1000
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowKill` | boolean | true | Allow killing processes |
| `denyUsers` | string[] | [] | Users whose processes cannot be killed |
| `maxResults` | number | 1000 | Maximum results to return |

## Security

### Process Killing

- Only allowed if `allowKill` is true
- Cannot kill processes owned by users in `denyUsers` list
- Supports process tree killing with `--children` flag
- Uses SIGTERM by default, SIGKILL with `--force`

### Signal Support

| Signal | Behavior |
|--------|----------|
| SIGTERM | Graceful termination (default) |
| SIGKILL | Force kill (cannot be caught) |
| SIGINT | Interrupt (Ctrl+C) |
| SIGSTOP | Pause process |
| SIGCONT | Resume paused process |

## Process Information

Each process entry includes:

- `pid` - Process ID
- `ppid` - Parent process ID
- `name` - Process name
- `cmd` - Full command line
- `user` - Owner username
- `cpu` - CPU percentage
- `mem` - Memory percentage
- `state` - Process state
- `startTime` - When process started
- `elapsed` - Time since start

## Examples

### Find and Kill Zombie Processes

```bash
# Find defunct processes
process find --name "<defunct>"

# Kill parent to reap zombies
process kill --pid <parent-pid>
```

### Monitor Node.js Process

```bash
# Find Node processes
process find --name node

# Monitor specific one
process monitor --pid 1234 --interval 1 --duration 60 --metrics cpu mem
```

### Find Memory Leaks

```bash
# Monitor top memory consumers
process top --by mem --interval 5 --count 12
```

### Kill Process Tree

```bash
# Find parent process
process find --name "webpack"

# Kill entire tree
process kill --pid 1234 --children --force
```

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| "Process not found" | PID doesn't exist | Check PID with `find` |
| "Permission denied" | Not owner or root | Run with appropriate privileges |
| "Invalid signal" | Unknown signal name | Use allowed signals only |

## Platform Support

- ✅ Linux - Full support
- ✅ macOS - Full support (some fields may differ)
- ⚠️ Windows - Limited support (no process tree)

## Dependencies

None - uses only Node.js built-in modules and system commands.

## License

MIT
