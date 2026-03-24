# JQ Tool - JSON and YAML Manipulation

A powerful tool for querying, filtering, and transforming JSON and YAML data using a jq-like syntax without requiring the jq binary to be installed.

## Features

- **Query Language**: jq-like syntax for traversing and transforming data
- **Multiple Formats**: Read JSON and YAML, output JSON, YAML, or compact JSON
- **Built-in Functions**: 20+ functions for data manipulation
- **No Dependencies**: Pure TypeScript implementation
- **File Operations**: Read from files or stdin, write to files

## Installation

```bash
cd tools/jq
pnpm install
```

## Usage

### Basic Queries

```bash
# Get a property
jq '.name' -f data.json

# Nested property access
jq '.user.profile.email' -f data.json

# Array access
jq '.users[0]' -f data.json

# Array slice
jq '.items[1:3]' -f data.json
```

### Built-in Functions

```bash
# Get object keys
jq 'keys' -f data.json

# Get array length
jq '.items | length' -f data.json

# Sort an array
jq '.items | sort' -f data.json

# Get unique values
jq '.items | unique' -f data.json

# Filter array
jq '.users | select(.active == true)' -f data.json

# Map over array
jq '.users | map(.name)' -f data.json

# Convert object to entries
jq '. | to_entries' -f data.json

# Sum values
jq '.prices | add' -f data.json
```

### Format Conversion

```bash
# YAML to JSON
jq '.' -f config.yaml --input-format yaml

# JSON to YAML
jq '.' -f data.json --output-format yaml

# Compact JSON output
jq '.' -f data.json --output-format compact
```

### Writing to Files

```bash
# Write output to file
jq '.users' -f data.json -o users.json

# Convert and save
jq '.' -f config.yaml --input-format yaml -o config.json
```

## Query Syntax

### Accessors

| Syntax | Description | Example |
|--------|-------------|---------|
| `.` | Identity (pass through) | `.` |
| `.foo` | Property access | `.name` |
| `.foo.bar` | Nested property | `.user.email` |
| `.[0]` | Array index | `.items[0]` |
| `.[1:3]` | Array slice | `.items[1:3]` |
| `.[].foo` | Map over array | `.users[].name` |
| `..` | Recursive descent | `..` |

### Functions

| Function | Description | Example |
|----------|-------------|---------|
| `keys` | Get object keys | `. \| keys` |
| `values` | Get object values | `. \| values` |
| `length` | Get length | `.items \| length` |
| `type` | Get type | `. \| type` |
| `sort` | Sort array | `.items \| sort` |
| `reverse` | Reverse | `.items \| reverse` |
| `unique` | Remove duplicates | `.items \| unique` |
| `flatten` | Flatten nested arrays | `.items \| flatten` |
| `first` | First element | `.items \| first` |
| `last` | Last element | `.items \| last` |
| `has("k")` | Check key exists | `. \| has("name")` |
| `contains("x")` | Check contains | `. \| contains("test")` |
| `to_entries` | Object to array | `. \| to_entries` |
| `from_entries` | Array to object | `. \| from_entries` |
| `add` | Sum/concatenate | `.numbers \| add` |
| `join(" ")` | Join with separator | `.words \| join(" ")` |
| `map(.x)` | Transform array | `.items \| map(.name)` |
| `select(.x)` | Filter array | `.items \| select(.active)` |

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--file <path>` | `-f` | Input file path |
| `--output <path>` | `-o` | Output file path |
| `--input-format <fmt>` | | Input format: json, yaml |
| `--output-format <fmt>` | | Output format: json, yaml, compact |
| `--raw` | `-r` | Raw string output (no quotes) |
| `--pretty` | `-p` | Pretty print JSON (default: true) |
| `--tab-width <n>` | | Tab width (default: 2) |
| `--sort-keys` | | Sort object keys alphabetically |
| `--help` | `-h` | Show help |

## Configuration

```json
{
  "maxFileSize": 10485760,
  "maxDepth": 10,
  "allowedPaths": ["/workspace"],
  "deniedPaths": ["/etc", "/root"],
  "allowWrite": true
}
```

## Security

- **Path Restrictions**: Configure `allowedPaths` and `deniedPaths` for file access control
- **File Size Limit**: Prevent processing of excessively large files
- **Depth Limit**: Prevent deeply nested output

## Examples

### API Response Processing

```bash
# Get all user emails from API response
jq '.data.users | map(.email)' -f response.json

# Count items
jq '.items | length' -f data.json

# Get first page of results
jq '.results[0:10]' -f search.json
```

### Configuration Management

```bash
# Convert YAML config to JSON
jq '.' -f config.yaml --input-format yaml -o config.json

# Extract database settings
jq '.database' -f config.yaml --input-format yaml

# Merge configs (using shell)
jq '.' -f base.json -o merged.json
jq '.' -f override.json --sort-keys >> merged.json
```

### Data Analysis

```bash
# Get unique values
jq '.logs | map(.level) | unique' -f logs.json

# Sort by value
jq '.items | sort | reverse' -f data.json

# Filter and transform
jq '.users | select(.active == true) | map(.email)' -f users.json
```

## License

MIT
