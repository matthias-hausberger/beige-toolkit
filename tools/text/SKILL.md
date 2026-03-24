# Text Tool Usage Guide

Quick reference for the Text tool.

## Most Common Commands

```bash
# Change case
text case --to upper -t "hello world"
text case --to snake -t "helloWorld"

# Encode/decode
text transform --ops base64encode -t "hello"
text transform --ops urlencode -t "hello world"

# Extract patterns
text extract --pattern email -f data.txt
text extract --pattern url -f document.txt

# Count words
text count -f document.txt

# Sort and unique
text sort -f lines.txt
text unique -f data.txt
```

## Quick Reference

### Case Conversions

| Case | Command |
|------|---------|
| Upper | `--to upper` |
| Lower | `--to lower` |
| Title | `--to title` |
| Camel | `--to camel` |
| Snake | `--to snake` |
| Kebab | `--to kebab` |
| Pascal | `--to pascal` |
| Constant | `--to constant` |

### Transforms

| Transform | Description |
|-----------|-------------|
| trim | Remove whitespace |
| urlencode | URL encode |
| base64encode | Base64 encode |
| htmlencode | Escape HTML |
| escape | Escape \n, \t, etc. |
| normalize | Unicode NFC |

### Extract Patterns

| Pattern | Extracts |
|---------|----------|
| email | Email addresses |
| url | HTTP URLs |
| phone | Phone numbers |
| ipv4 | IPv4 addresses |
| number | Numbers |
| uuid | UUIDs |
| date | Dates |

### Line Operations

```bash
text sort --numeric --reverse -f nums.txt
text unique --count -f data.txt
text trim --mode left -f indented.txt
text wrap --width 80 -f document.txt
```

## Examples

### Clean up a file

```bash
# Trim lines, remove blanks, sort unique
text trim -f data.txt | text sort -u
```

### Extract all URLs from HTML

```bash
text extract --pattern url -f page.html --unique --sort
```

### Prepare text for JSON

```bash
text transform --ops trim,escape -t "hello world"
```

### Count document stats

```bash
text count -f document.txt
# {"words": 1234, "characters": 5678, "lines": 89}
```
