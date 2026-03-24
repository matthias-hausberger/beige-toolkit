# Diff Tool

Compare files and directories to find differences.

## Installation

```bash
# Clone or copy to your beige-toolkit tools directory
```

## Commands

### `diff files <file1> <file2>`

Compare two files and show line-by-line differences.

```bash
diff files old.txt new.txt
diff files src.ts dest.ts -c 5  # 5 context lines
diff files a.txt b.txt -f json  # JSON output
```

**Options:**
- `--format, -f <format>` - Output format: `unified` (default), `json`
- `--context, -c <n>` - Number of context lines (default: 3)

### `diff dirs <dir1> <dir2>`

Compare two directories and list differences.

```bash
diff dirs src/ dist/
diff dirs v1/ v2/ -r        # Recursive
diff dirs a/ b/ -f json     # JSON output
```

**Options:**
- `--recursive, -r` - Compare subdirectories
- `--content` - Show content diff for changed files
- `--format, -f <format>` - Output format: `summary` (default), `json`

### `diff text <text1> <text2>`

Compare two text strings.

```bash
diff text "hello world" "hello there"
```

**Options:**
- `--format, -f <format>` - Output format: `unified` (default), `json`
- `--context, -c <n>` - Number of context lines (default: 3)

### `diff json <json1> <json2>`

Compare two JSON objects and show structural differences.

```bash
diff json '{"a":1}' '{"a":2}'
diff json '{"users":[]}' '{"users":[{"id":1}]}'
```

**Options:**
- `--format, -f <format>` - Output format: `summary` (default), `json`

### `diff lines <text1> <text2>`

Compare two sets of lines (ignoring order).

```bash
diff lines "a\nb\nc" "b\nc\nd"
```

**Options:**
- `--ignore-empty` - Ignore empty lines
- `--format, -f <format>` - Output format: `summary` (default), `json`

## Output Formats

### Unified Format

Standard diff output with context lines:

```
--- file1.txt
+++ file2.txt

@@ -1,3 +1,3 @@
  line 1
- line 2
+ new line 2
  line 3

2 additions, 1 deletions, 2 unchanged
```

### JSON Format

Structured JSON output for programmatic use:

```json
{
  "file1": "old.txt",
  "file2": "new.txt",
  "stats": {
    "added": 2,
    "removed": 1,
    "unchanged": 5
  },
  "diff": [...]
}
```

## Configuration

Configure via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DIFF_MAX_FILE_SIZE` | `10485760` | Maximum file size to compare (bytes) |
| `DIFF_CONTEXT_LINES` | `3` | Default context lines |

Tool config in `tool.json`:

```json
{
  "maxFileSize": 10485760,
  "contextLines": 3,
  "allowedPaths": [],
  "deniedPaths": []
}
```

## Security

- **Path restrictions**: Use `allowedPaths` and `deniedPaths` to restrict file access
- **Size limits**: Large files are rejected to prevent memory issues
- **No shell execution**: Pure TypeScript implementation

## Algorithm

Uses the Longest Common Subsequence (LCS) algorithm for accurate line-by-line diffing.

## Examples

### Compare code files

```bash
diff files src/index.ts dist/index.ts
```

### Compare package versions

```bash
diff json "$(cat package-lock.v1.json)" "$(cat package-lock.v2.json)"
```

### Find changed files between directories

```bash
diff dirs build/ dist/ -r
```

### Check if configs differ

```bash
diff files config.local.json config.prod.json
```
