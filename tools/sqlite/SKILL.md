# SQLite Tool Usage Guide

Quick reference for using the SQLite database tool in beige agents.

## Basic Commands

```bash
# Query
/tools/bin/sqlite query --db /path/to/db "SELECT * FROM table LIMIT 10"

# List tables
/tools/bin/sqlite tables --db /path/to/db

# Show schema
/tools/bin/sqlite schema --db /path/to/db --table tablename

# Validate SQL
/tools/bin/sqlite validate "SELECT * FROM users"
```

## Output Formats

```bash
--format json    # Default, structured output
--format table   # Human-readable table
--format csv     # CSV format for export
```

## Common Patterns

### Check if record exists

```bash
sqlite query --db /data/app.db "SELECT 1 FROM users WHERE id = 123 LIMIT 1"
```

### Get count

```bash
sqlite query --db /data/app.db "SELECT COUNT(*) as count FROM logs"
```

### Get latest records

```bash
sqlite query --db /data/app.db "SELECT * FROM events ORDER BY created_at DESC LIMIT 10"
```

### Search with LIKE

```bash
sqlite query --db /data/app.db "SELECT * FROM users WHERE email LIKE '%@example.com'"
```

## Security Notes

- By default, only SELECT queries are allowed
- Database paths must be in `allowDatabases` config
- Results are limited to `maxRows` (default: 1000)
