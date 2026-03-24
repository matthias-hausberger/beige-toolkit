# CSV Tool Usage Guide

Quick reference for the CSV tool.

## Most Common Commands

```bash
# Read a CSV file
csv read data.csv

# Read with table output
csv read data.csv --format table

# Filter data
csv query data.csv --where "status = active"

# Convert to JSON
csv convert data.csv --to json

# Get statistics
csv stats data.csv
```

## Quick Reference

### Read/View

| Command | Description |
|---------|-------------|
| `csv read file.csv` | Read entire file |
| `csv head file.csv -n 20` | First 20 rows |
| `csv tail file.csv -n 10` | Last 10 rows |
| `csv stats file.csv` | File statistics |
| `csv validate file.csv` | Check for issues |

### Query/Filter

| Command | Description |
|---------|-------------|
| `--where "col = value"` | Equals filter |
| `--where "col > 100"` | Numeric filter |
| `--where "col ~ pattern"` | Regex filter |
| `--select "a,b,c"` | Select columns |
| `--orderBy col` | Sort ascending |
| `--orderBy col --orderDir desc` | Sort descending |

### Convert

| Command | Description |
|---------|-------------|
| `--to json` | Output as JSON |
| `--to jsonl` | Output as JSONL |
| `--to tsv` | Output as TSV |
| `--to md` | Output as Markdown table |
| `-o output.json` | Save to file |

### Write

```bash
# Create from JSON
csv write output.csv --data '[{"a":1,"b":2}]'

# Append rows
csv write data.csv --data '[...]' --append
```

## Examples

### Filter active users over 25

```bash
csv query users.csv --where "status = active" --where "age > 25"
```

### Get top 10 by sales

```bash
csv query sales.csv --orderBy amount --orderDir desc --limit 10
```

### Export contacts as JSON

```bash
csv query contacts.csv --select "name,email,phone" --format json > contacts.json
```

### Convert TSV to CSV

```bash
csv convert data.tsv --delimiter "\t" --to csv -o data.csv
```
