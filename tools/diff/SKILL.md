# Diff Tool Usage Guide

Compare files and directories to find differences.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `diff files <a> <b>` | Compare two files |
| `diff dirs <a> <b>` | Compare two directories |
| `diff text <a> <b>` | Compare text strings |
| `diff json <a> <b>` | Compare JSON objects |
| `diff lines <a> <b>` | Compare line sets (unordered) |

## Common Tasks

### Compare Two Files

```bash
diff files old.txt new.txt
```

Output shows:
- `+` lines added
- `-` lines removed
- ` ` lines unchanged

### Compare Directories

```bash
# Basic comparison
diff dirs src/ dist/

# Include subdirectories
diff dirs v1/ v2/ -r

# JSON output for parsing
diff dirs a/ b/ -f json
```

### Compare JSON Objects

```bash
# Find what changed between configs
diff json '{"debug":false}' '{"debug":true}'
```

Output shows path-based differences:
- `~ path.to.key: old -> new` (value changed)
- `+ path.to.key: value` (key added)
- `- path.to.key: value` (key removed)

### Compare Line Sets

When order doesn't matter:

```bash
diff lines "a\nb\nc" "b\nc\nd"
```

Shows lines only in first, only in second, and common.

## Options

| Option | Description |
|--------|-------------|
| `-f, --format <fmt>` | Output format: `unified`, `summary`, `json` |
| `-c, --context <n>` | Context lines around changes |
| `-r, --recursive` | Compare subdirectories |

## Examples

```bash
# Code review helper
diff files src/old.ts src/new.ts -c 10

# Check if files are identical
diff files a.txt b.txt | grep "0 additions"

# Find new/removed files
diff dirs old-release/ new-release/ -r

# Compare API responses
diff json "$response1" "$response2"
```
