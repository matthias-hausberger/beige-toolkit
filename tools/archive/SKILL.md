# Archive Tool - Usage Guide

Quick reference for using the Archive tool in your Beige agent.

## Basic Commands

### Create Archive

```bash
# Create tar.gz (auto-detected from extension)
archive create --archive backup.tar.gz --files src,config.json

# Create zip
archive create --archive project.zip --files dist

# With working directory
archive create --archive release.tar.gz --files . --working-dir /workspace/project
```

### Extract Archive

```bash
# Extract to current directory
archive extract --archive backup.tar.gz

# Extract to specific directory
archive extract --archive backup.tar.gz --output-dir /workspace/restored

# Overwrite existing files
archive extract --archive backup.tar.gz --overwrite

# Strip top-level directory
archive extract --archive package.tar.gz --strip-components 1
```

### List Contents

```bash
# Simple list
archive list --archive backup.tar.gz

# Detailed view
archive list --archive backup.tar.gz --verbose
```

### Test Integrity

```bash
archive test --archive backup.tar.gz
```

### Add to Zip

```bash
# Add files to existing zip
archive add --archive backup.zip --files newfile.txt,another.json
```

## Common Patterns

### Backup Before Changes

```bash
archive create --archive pre-change-backup.tar.gz --files /workspace/project
```

### Extract Downloaded Package

```bash
archive extract --archive download.tar.gz --strip-components 1 --output-dir /workspace/new-project
```

### Verify and Extract

```bash
# Test first, then extract if valid
archive test --archive backup.tar.gz && archive extract --archive backup.tar.gz
```

## Tips

- Format is auto-detected from file extension
- Use `--working-dir` to create archives with relative paths
- Use `--strip-components 1` to remove top-level directory from extracted files
- `--verbose` shows file sizes and dates in listings
- Only zip supports `add` command (tar archives are not easily modifiable)
