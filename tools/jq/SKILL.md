# JQ Tool Usage Guide

Query and transform JSON/YAML data with jq-like syntax.

## Quick Start

```bash
# Read property from JSON file
jq '.name' -f data.json

# Pipe from stdin
cat data.json | jq '.users | length'

# Convert YAML to JSON
jq '.' -f config.yaml --input-format yaml
```

## Common Patterns

### Extract Nested Data

```bash
jq '.response.data.users[0].email' -f api.json
```

### Process Arrays

```bash
# Get all names
jq '.users | map(.name)' -f data.json

# Filter and map
jq '.items | select(.price > 100) | map(.name)' -f products.json

# First/last item
jq '.items | first' -f data.json
jq '.items | last' -f data.json
```

### Format Conversion

```bash
# YAML to JSON
jq '.' -f config.yaml --input-format yaml -o config.json

# JSON to YAML
jq '.' -f data.json --output-format yaml
```

### Aggregation

```bash
# Count items
jq '.items | length' -f data.json

# Sum numbers
jq '.prices | add' -f data.json

# Get unique values
jq '.tags | unique' -f data.json
```

## All Options

| Option | Description |
|--------|-------------|
| `-f, --file` | Input file |
| `-o, --output` | Output file |
| `--input-format` | json or yaml |
| `--output-format` | json, yaml, or compact |
| `-r, --raw` | Raw string output |
| `--sort-keys` | Sort object keys |
| `-h, --help` | Show help |
