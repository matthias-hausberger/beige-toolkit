# CSV Tool

Parse, query, and manipulate CSV/TSV files with SQL-like capabilities.

## Overview

The CSV tool provides comprehensive functionality for working with delimited text files:

- **Read/Write**: Parse CSV files and create new ones from JSON data
- **Query**: SQL-like filtering, sorting, and column selection
- **Convert**: Transform between CSV, TSV, JSON, JSONL, and Markdown formats
- **Analyze**: Get statistics and validate file structure

## Installation

```bash
# Clone and install in beige-toolkit
cd /path/to/beige-toolkit/tools/csv
pnpm install
```

## Commands

### read - Read CSV File

Read and display CSV file contents:

```bash
# Basic read
csv read data.csv

# Read TSV file
csv read data.tsv --delimiter "\t"

# Custom output format
csv read data.csv --format table
csv read data.csv --format csv

# Limit and offset
csv read data.csv --limit 100 --offset 50

# File without headers
csv read data.csv --no-header
```

### write - Create CSV File

Create a CSV file from JSON data:

```bash
# Write new file
csv write output.csv --data '[{"name":"Alice","age":"30"},{"name":"Bob","age":"25"}]'

# Append to existing file
csv write data.csv --data '[{"name":"Charlie","age":"35"}]' --append

# Write TSV
csv write data.tsv --delimiter "\t" --data '[...]'
```

### query - Query CSV Data

SQL-like queries with filtering, sorting, and column selection:

```bash
# Filter rows
csv query data.csv --where "age > 30"
csv query data.csv --where "status = active"
csv query data.csv --where "name ~ John"

# Select columns
csv query data.csv --select "name,email,age"

# Sort results
csv query data.csv --orderBy age --orderDir desc

# Combine options
csv query data.csv --where "status = active" --select "name,email" --orderBy name --limit 50
```

**Filter Operators:**

| Operator | Description | Example |
|----------|-------------|---------|
| `=` `==` | Equals | `status = active` |
| `!=` | Not equals | `status != inactive` |
| `>` | Greater than | `age > 30` |
| `<` | Less than | `price < 100` |
| `>=` | Greater or equal | `score >= 80` |
| `<=` | Less or equal | `quantity <= 10` |
| `~` | Regex match | `name ~ ^A` |
| `!~` | Regex not match | `email !~ @test` |

### convert - Format Conversion

Convert between different formats:

```bash
# CSV to JSON
csv convert data.csv --to json

# CSV to JSONL (newline-delimited JSON)
csv convert data.csv --to jsonl

# CSV to TSV
csv convert data.csv --to tsv

# CSV to Markdown table
csv convert data.csv --to md

# TSV to JSON
csv convert data.tsv --from tsv --to json

# Save to file
csv convert data.csv --to json --output data.json
```

### stats - File Statistics

Get statistics about a CSV file:

```bash
csv stats data.csv
```

Output includes:
- File size
- Row and column count
- Per-column type detection
- Empty value counts
- Unique value counts
- Sample values

### validate - Validate Structure

Check CSV file for issues:

```bash
csv validate data.csv
```

Detects:
- Unclosed quotes
- Inconsistent column counts
- Malformed rows

### head / tail - View Rows

View first or last N rows:

```bash
# First 10 rows
csv head data.csv

# First 20 rows
csv head data.csv -n 20

# Last 10 rows
csv tail data.csv

# Last 5 rows as table
csv tail data.csv -n 5 --format table
```

### select - Select Columns

Extract specific columns:

```bash
csv select data.csv --columns "name,email,phone"

# Output as JSON
csv select data.csv --columns "name,age" --format json
```

### filter - Filter Rows

Simple row filtering:

```bash
# Exact match
csv filter data.csv --column status --value active

# Regex match
csv filter data.csv --column email --operator "~" --value "@gmail"

# Numeric comparison
csv filter data.csv --column age --operator ">" --value 30
```

### sort - Sort Rows

Sort by column:

```bash
# Ascending (default)
csv sort data.csv --column age

# Descending
csv sort data.csv --column price --direction desc
```

## Options Reference

### General Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--delimiter` | `-d` | Field delimiter | `,` |
| `--format` | `-f` | Output format (json, csv, table) | `json` |
| `--output` | `-o` | Output file | - |
| `--limit` | | Maximum rows to return | 10000 |
| `--offset` | | Skip first N rows | 0 |
| `--no-header` | | File has no header row | false |

### Query Options

| Option | Short | Description |
|--------|-------|-------------|
| `--select` | | Columns to select (comma-separated) |
| `--where` | `-w` | Filter expression |
| `--orderBy` | | Sort by column |
| `--orderDir` | | Sort direction (asc, desc) |

### Filter Options

| Option | Short | Description |
|--------|-------|-------------|
| `--column` | `-c` | Column to filter on |
| `--operator` | `-O` | Comparison operator |
| `--value` | `-v` | Value to compare |

### Convert Options

| Option | Description | Values |
|--------|-------------|--------|
| `--from` | Input format | csv, tsv |
| `--to` | Output format | json, jsonl, csv, tsv, md |

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `CSV_MAX_FILE_SIZE` | Maximum file size in bytes | 52428800 (50MB) |
| `CSV_MAX_ROWS` | Maximum rows to process | 10000 |
| `CSV_PATH_ALLOW_LIST` | Allowed path patterns | - |
| `CSV_PATH_DENY_LIST` | Denied path patterns | - |

## Security

- **File size limits**: Prevents memory exhaustion
- **Row limits**: Protects against large datasets
- **Path validation**: Allow/deny lists for file access
- **Safe parsing**: Handles quotes and special characters

## Examples

### Process a log file

```bash
# Filter error logs
csv filter logs.csv --column level --value ERROR

# Get unique IPs
csv query logs.csv --select "ip" | jq 'unique'
```

### Data transformation pipeline

```bash
# Read, filter, convert
csv query data.csv --where "status = active" --select "name,email" | \
  csv convert --from csv --to json --output contacts.json
```

### Analyze dataset

```bash
# Get overview
csv stats sales.csv

# Top 10 customers
csv query sales.csv --orderBy total --orderDir desc --limit 10

# Validate before processing
csv validate sales.csv && echo "Ready for import"
```

## Error Handling

The tool returns JSON error messages:

```json
{
  "error": "File not found: data.csv"
}
```

Exit codes:
- `0` - Success
- `1` - Error (file not found, invalid syntax, etc.)
