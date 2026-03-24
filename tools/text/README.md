# Text Tool

Text processing, transformation, and analysis tool.

## Overview

The Text tool provides comprehensive text manipulation capabilities:

- **Case transformations**: 13 case styles (camelCase, snake_case, etc.)
- **Text transforms**: Encoding, escaping, trimming, normalizing
- **Template substitution**: Replace placeholders with values
- **Counting**: Characters, words, lines, sentences
- **Pattern extraction**: Extract emails, URLs, numbers, etc.
- **Find & replace**: Regex-based text replacement
- **Line operations**: Sort, unique, reverse, wrap

## Commands

### case - Change Text Case

Convert text between different case styles:

```bash
# To uppercase
text case --to upper -t "hello world"

# To camelCase
text case --to camel -t "hello-world"

# To snake_case
text case --to snake -t "helloWorld"
```

**Available cases:**

| Case | Example |
|------|---------|
| upper | HELLO WORLD |
| lower | hello world |
| title | Hello World |
| sentence | Hello world. This is a test |
| camel | helloWorld |
| pascal | HelloWorld |
| snake | hello_world |
| kebab | hello-world |
| constant | HELLO_WORLD |
| dot | hello.world |
| path | hello/world |
| train | Hello-World |
| header | Hello-World |

### transform - Apply Transformations

Apply one or more transformations:

```bash
# Single transform
text transform --ops trim -t "  hello  "

# Multiple transforms (applied in order)
text transform --ops trim,urlencode -t "hello world"

# Base64 encode
text transform --ops base64encode -t "hello"

# HTML escape
text transform --ops htmlencode -t "<script>alert('xss')</script>"
```

**Available transforms:**

| Transform | Description |
|-----------|-------------|
| trim | Remove leading/trailing whitespace |
| ltrim | Remove leading whitespace |
| rtrim | Remove trailing whitespace |
| normalize | Unicode NFC normalization |
| nfc | NFC normalization |
| nfd | NFD normalization |
| nfkc | NFKC normalization |
| nfkd | NFKD normalization |
| escape | Escape special characters (\n, \t, etc.) |
| unescape | Unescape special characters |
| urlencode | URL percent-encoding |
| urldecode | Decode URL encoding |
| base64encode | Base64 encode |
| base64decode | Base64 decode |
| htmlencode | HTML entity encoding |
| htmldecode | Decode HTML entities |
| strip | Remove HTML tags |
| compact | Reduce multiple blank lines |
| dedent | Remove common leading whitespace |
| indent | Add 2-space indentation |

### template - Template Substitution

Replace placeholders with values:

```bash
# Basic substitution
text template -t "Hello {{name}}!" --data '{"name":"Alice"}'

# Custom delimiters
text template -t "Hello ${name}!" --prefix '${' --suffix '}' --data '{"name":"Alice"}'

# Multiple values
text template -t "{{greeting}} {{name}}!" --data '{"greeting":"Hi","name":"Bob"}'

# From file
text template -f template.txt --data '{"name":"Alice","date":"2026-03-24"}'
```

### count - Text Statistics

Count characters, words, lines, etc.:

```bash
text count -t "Hello world, this is a test."

# From file
text count -f document.txt
```

Output:
```json
{
  "bytes": 27,
  "characters": 27,
  "charactersNoSpaces": 22,
  "words": 6,
  "lines": 1,
  "nonEmptyLines": 1,
  "paragraphs": 1,
  "sentences": 1
}
```

### extract - Extract Patterns

Extract matching patterns from text:

```bash
# Extract emails
text extract --pattern email -f contacts.txt

# Extract URLs
text extract --pattern url -f document.txt

# Extract numbers
text extract --pattern number -f data.txt

# With custom regex
text extract --pattern "\d{4}-\d{2}-\d{2}" -f log.txt

# Unique and sorted
text extract --pattern email -f data.txt --unique --sort
```

**Built-in patterns:**

| Pattern | Description |
|---------|-------------|
| email | Email addresses |
| url | HTTP/HTTPS URLs |
| phone | Phone numbers |
| ipv4 | IPv4 addresses |
| ipv6 | IPv6 addresses |
| number | Any number (int or float) |
| integer | Integers only |
| float | Floating-point only |
| hex | Hex color codes |
| uuid | UUIDs |
| date | Date patterns |
| time | Time patterns |
| word | Words |
| line | Lines |

### replace - Find and Replace

```bash
# Simple replace
text replace --find "foo" --replace "bar" -t "foo is foo"

# Case-insensitive
text replace --find "HELLO" --replace "hi" --ignoreCase -t "hello world"

# Replace first only
text replace --find "foo" --replace "bar" --all=false -t "foo foo foo"
```

### trim - Trim Lines

Trim whitespace from each line:

```bash
# Trim both sides
text trim -t "  hello  \n  world  "

# Trim left only
text trim --mode left -t "  hello"

# Trim right only
text trim --mode right -t "hello  "
```

### pad - Pad Text

Pad text to a specific width:

```bash
# Pad right
text pad --width 20 -t "hello"

# Pad left
text pad --width 20 --side left -t "hello"

# Pad center
text pad --width 20 --side center -t "hello"

# Custom character
text pad --width 20 --char "-" -t "hello"
```

### wrap - Word Wrap

Wrap text to column width:

```bash
# Wrap at 80 characters
text wrap --width 80 -f document.txt

# Custom width
text wrap --width 40 -t "This is a long sentence that needs wrapping."
```

### align - Align Text

Align lines within a width:

```bash
# Left align (default)
text align --width 80 -t "hello"

# Right align
text align --width 80 --side right -t "hello"

# Center align
text align --width 80 --side center -t "hello"
```

### sort - Sort Lines

Sort lines alphabetically or numerically:

```bash
# Alphabetical sort
text sort -f lines.txt

# Numeric sort
text sort --numeric -f numbers.txt

# Reverse order
text sort --reverse -f lines.txt

# Unique sorted
text sort --unique -f lines.txt
```

### unique - Remove Duplicates

Remove duplicate lines:

```bash
# Remove duplicates
text unique -f data.txt

# Case-insensitive
text unique --caseSensitive=false -f data.txt

# Show counts
text unique --count -f data.txt
```

### reverse - Reverse Text

Reverse characters, words, or lines:

```bash
# Reverse characters
text reverse -t "hello"

# Reverse words
text reverse --mode words -t "hello world"

# Reverse lines
text reverse --mode lines -f lines.txt
```

## Options Reference

| Option | Short | Description |
|--------|-------|-------------|
| `--text` | `-t` | Input text |
| `--file` | `-f` | Input file |
| `--output` | `-o` | Output file |
| `--to` | | Target case style |
| `--ops` | | Transform operations (comma-separated) |
| `--data` | `-d` | Template data (JSON) |
| `--pattern` | `-p` | Extract pattern |
| `--unique` | `-u` | Remove duplicates |
| `--sort` | `-s` | Sort results |
| `--find` | | Text to find |
| `--replace` | `-r` | Replacement text |
| `--ignoreCase` | `-i` | Case-insensitive |
| `--width` | `-w` | Width for wrap/pad/align |
| `--numeric` | `-n` | Numeric sort |
| `--reverse` | | Reverse order |
| `--count` | | Show counts |

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `TEXT_MAX_INPUT_SIZE` | Maximum input size in bytes | 10485760 (10MB) |
| `TEXT_DEFAULT_ENCODING` | Text encoding | utf-8 |

## Examples

### Process a document

```bash
# Count words
text count -f document.txt

# Extract all emails
text extract --pattern email -f document.txt --unique

# Convert to sentence case
text case --to sentence -f document.txt
```

### Clean up data

```bash
# Trim, deduplicate, sort
cat data.txt | text trim | text unique | text sort
```

### Template processing

```bash
# Generate config from template
text template -f config.template.json --data '{"host":"example.com","port":"8080"}'
```
