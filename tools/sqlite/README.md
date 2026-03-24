# SQLite Database Tool

Query SQLite databases with SQL from beige agents. Supports SELECT queries, schema inspection, and optionally write operations.

## Features

- **SQL Queries**: Execute any SQL query against SQLite databases
- **Schema Inspection**: List tables and view table schemas
- **Multiple Output Formats**: JSON (default), table, CSV
- **Security Controls**: Allow/deny lists for database access
- **Readonly Mode**: Default to SELECT-only queries for safety
- **Result Limiting**: Prevent large result sets from overwhelming output

## Installation

The tool uses the `sqlite3` CLI which must be installed on the gateway host:

```bash
# Ubuntu/Debian
sudo apt-get install sqlite3

# macOS
brew install sqlite3

# Alpine
apk add sqlite
```

## Configuration

Add to your agent's tool configuration:

```json
{
  "tools": {
    "sqlite": {
      "allowDatabases": ["/data/*.db", "/workspace/**/*.sqlite"],
      "denyDatabases": ["/data/secrets.db"],
      "defaultDatabase": "/data/app.db",
      "maxRows": 1000,
      "readonly": true
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowDatabases` | `string[]` | `[]` | Glob patterns for allowed databases. Use `["*"]` to allow all. |
| `denyDatabases` | `string[]` | `[]` | Glob patterns for denied databases. Takes precedence over allow. |
| `defaultDatabase` | `string` | `""` | Default database path if `--db` not specified |
| `maxRows` | `number` | `1000` | Maximum rows to return in results |
| `readonly` | `boolean` | `true` | Only allow SELECT, PRAGMA, and EXPLAIN queries |

## Usage

### Query a Database

```bash
# Basic query
sqlite query --db /data/app.db "SELECT * FROM users LIMIT 10"

# With table format
sqlite query --db /data/app.db "SELECT id, name FROM users" --format table

# CSV output
sqlite query --db /data/app.db "SELECT * FROM logs WHERE date > '2024-01-01'" --format csv
```

### List Tables

```bash
sqlite tables --db /data/app.db
```

### Show Schema

```bash
# All tables
sqlite schema --db /data/app.db

# Specific table
sqlite schema --db /data/app.db --table users
```

### Validate SQL

```bash
sqlite validate "SELECT * FROM users WHERE id = 1"
```

### List Allowed Databases

```bash
sqlite databases
```

## Output Formats

### JSON (default)

```json
{
  "columns": ["id", "name", "email"],
  "rows": [
    {"id": 1, "name": "Alice", "email": "alice@example.com"},
    {"id": 2, "name": "Bob", "email": "bob@example.com"}
  ],
  "rowCount": 2,
  "truncated": false
}
```

### Table

```
id | name  | email             
---+-------+-------------------
1  | Alice | alice@example.com 
2  | Bob   | bob@example.com   
```

### CSV

```csv
id,name,email
1,Alice,alice@example.com
2,Bob,bob@example.com
```

## Security

### Readonly Mode

By default, the tool only allows:
- `SELECT` queries
- `PRAGMA` statements (for schema inspection)
- `EXPLAIN` statements (for query analysis)

To enable write operations:

```json
{
  "tools": {
    "sqlite": {
      "readonly": false
    }
  }
}
```

**Warning**: Enable write access only if you trust the agent completely.

### Database Access Control

The `allowDatabases` and `denyDatabases` options use glob patterns:

| Pattern | Matches |
|---------|---------|
| `*.db` | Any `.db` file in allowed directories |
| `/data/*.db` | Any `.db` file in `/data/` |
| `/workspace/**/*.sqlite` | Any `.sqlite` file anywhere under `/workspace/` |
| `*` | All databases (use with caution) |

## Environment Variables

Configuration can also be set via environment variables:

| Variable | Equivalent Config |
|----------|-------------------|
| `SQLITE_ALLOW_DATABASES` | `allowDatabases` (comma-separated) |
| `SQLITE_DENY_DATABASES` | `denyDatabases` (comma-separated) |
| `SQLITE_DEFAULT_DATABASE` | `defaultDatabase` |
| `SQLITE_MAX_ROWS` | `maxRows` |
| `SQLITE_READONLY` | `readonly` |

## Examples

### Query with Row Limit

```bash
sqlite query --db /data/logs.db "SELECT * FROM events" --limit 100
```

### Count Records

```bash
sqlite query --db /data/app.db "SELECT COUNT(*) as total FROM users"
```

### Join Tables

```bash
sqlite query --db /data/app.db "
  SELECT u.name, o.total 
  FROM users u 
  JOIN orders o ON u.id = o.user_id 
  WHERE o.status = 'completed'
  LIMIT 10
"
```

### Check if Table Exists

```bash
sqlite query --db /data/app.db "
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name='users'
"
```

## Error Handling

The tool provides clear error messages:

```
Error: Database '/data/secret.db' is not in the allowed list.
```

```
Error: Only SELECT queries are allowed in readonly mode.
Set SQLITE_READONLY=false to enable write operations.
```

```
SQLite error: no such table: nonexistent_table
```

## Limitations

- Large results are truncated to `maxRows`
- Very long queries may need to be in a file (shell escaping)
- Binary data (BLOBs) is returned as hex strings
- Only SQLite databases are supported (not PostgreSQL, MySQL, etc.)
