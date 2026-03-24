# Archive Tool

Create and extract archives (zip, tar, tar.gz, tar.bz2) from within your Beige agent.

## Overview

The Archive tool provides comprehensive archive management capabilities:

- **Create** archives from files and directories
- **Extract** archives to specified locations
- **List** contents of archives
- **Test** archive integrity
- **Add** files to existing zip archives

Supports multiple formats: zip, tar, tar.gz (tgz), tar.bz2 (tbz2).

## Installation

This tool is part of the Beige toolkit. It uses standard system utilities (`tar`, `zip`, `unzip`) available on most Unix-like systems.

## Commands

### `create` - Create a new archive

```bash
archive create --archive <path> --files <file1,file2,...> [options]
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--archive` | string | Yes | Path to the archive file to create |
| `--files` | string | Yes | Comma-separated list of files/directories to include |
| `--format` | string | No | Archive format: zip, tar, tar.gz, tar.bz2 (auto-detected from extension) |
| `--compress-level` | number | No | Compression level 1-9 (default: 6, only for gzip/bzip2) |
| `--working-dir` | string | No | Working directory for relative paths |

**Examples:**

```bash
# Create a tar.gz archive
archive create --archive backup.tar.gz --files src,config.json

# Create a zip with maximum compression
archive create --archive project.zip --files dist --compress-level 9

# Create archive with relative paths
archive create --archive /tmp/release.tar.gz --files . --working-dir /workspace/project
```

### `extract` - Extract an archive

```bash
archive extract --archive <path> [options]
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--archive` | string | Yes | Path to the archive file to extract |
| `--output-dir` | string | No | Directory to extract files to (default: current directory) |
| `--files` | string | No | Comma-separated patterns of specific files to extract |
| `--strip-components` | number | No | Remove leading path components (tar only) |
| `--overwrite` | boolean | No | Overwrite existing files (default: false) |

**Examples:**

```bash
# Extract to current directory
archive extract --archive backup.tar.gz

# Extract to specific directory
archive extract --archive release.zip --output-dir /workspace/project

# Extract specific files
archive extract --archive data.tar.gz --files "config/*.json"

# Extract and strip top-level directory
archive extract --archive package.tar.gz --strip-components 1
```

### `list` / `ls` - List archive contents

```bash
archive list --archive <path> [--verbose]
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--archive` | string | Yes | Path to the archive file to list |
| `--verbose` | boolean | No | Show detailed information (size, date, etc.) |

**Examples:**

```bash
# List archive contents
archive list --archive backup.tar.gz

# Detailed listing
archive list --archive project.zip --verbose
```

### `test` / `verify` - Test archive integrity

```bash
archive test --archive <path>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--archive` | string | Yes | Path to the archive file to test |

**Examples:**

```bash
# Test if archive is valid
archive test --archive backup.tar.gz
```

### `add` - Add files to existing archive (zip only)

```bash
archive add --archive <path> --files <file1,file2,...> [--working-dir <dir>]
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--archive` | string | Yes | Path to the zip archive |
| `--files` | string | Yes | Comma-separated list of files to add |
| `--working-dir` | string | No | Working directory for relative paths |

**Examples:**

```bash
# Add a file to existing zip
archive add --archive project.zip --files README.md

# Add multiple files
archive add --archive backup.zip --files config.json,data.json
```

## Configuration

The tool supports the following configuration options in `tool.json`:

```json
{
  "allowPaths": ["*.tar.gz", "/workspace/**"],
  "denyPaths": ["/etc/**", "~/.ssh/**"],
  "maxArchiveSize": "1GB",
  "maxFileSize": "100MB"
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowPaths` | string[] | - | Allowed path patterns (glob). If set, only these paths can be accessed. |
| `denyPaths` | string[] | - | Denied path patterns (glob). These paths can never be accessed. |
| `maxArchiveSize` | string | "1GB" | Maximum archive size for extraction |
| `maxFileSize` | string | "100MB" | Maximum individual file size when extracting |

## Supported Formats

| Format | Extension(s) | Description |
|--------|--------------|-------------|
| zip | .zip | Standard zip archive |
| tar | .tar | Uncompressed tar archive |
| tar.gz | .tar.gz, .tgz | Gzip-compressed tar |
| tar.bz2 | .tar.bz2, .tbz2 | Bzip2-compressed tar |

## Security Considerations

- Path access can be restricted via `allowPaths` and `denyPaths` configuration
- Archive size limits prevent extraction of extremely large archives
- File size limits prevent extraction of extremely large individual files
- The tool validates paths before any operation

## Use Cases

### Backups

```bash
# Create backup of workspace
archive create --archive backup-$(date +%Y%m%d).tar.gz --files /workspace
```

### Deployment Packages

```bash
# Create release package
archive create --archive release.tar.gz --files dist,package.json,README.md --working-dir project
```

### Extracting Downloads

```bash
# Extract downloaded source code
archive extract --archive source.tar.gz --strip-components 1 --output-dir src
```

### Verification

```bash
# Verify backup before extraction
archive test --archive important-backup.tar.gz && archive extract --archive important-backup.tar.gz
```

## Error Handling

The tool returns structured results:

**Success:**
```json
{
  "success": true,
  "data": {
    "archive": "backup.tar.gz",
    "format": "tar.gz",
    "size": 1048576,
    "sizeFormatted": "1 MB",
    "files": 5
  },
  "message": "Created tar.gz archive: backup.tar.gz (1 MB)"
}
```

**Error:**
```json
{
  "success": false,
  "error": "File not found: missing-file.txt"
}
```

## Dependencies

This tool requires the following system utilities:

- `tar` - for tar, tar.gz, tar.bz2 archives
- `zip` / `unzip` - for zip archives

These are typically pre-installed on most Unix-like systems.

## License

MIT
