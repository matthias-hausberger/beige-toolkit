# Wrangler Tool Usage Guide

This tool wraps the Cloudflare Wrangler CLI for managing Workers, D1, KV, R2, and other Cloudflare services.

## Basic Commands

```bash
# Deploy a Worker
wrangler deploy

# Start local development
wrangler dev

# View logs
wrangler tail

# Help
wrangler --help
```

## D1 (SQLite Database)

```bash
# List databases
wrangler d1 database list

# Create database
wrangler d1 database create <name>

# Query database
wrangler d1 execute <database> --command "SELECT * FROM users"

# Query from file
wrangler d1 execute <database> --file ./schema.sql

# Interactive shell (local)
wrangler d1 execute <database> --local --command ".tables"
```

## KV (Key-Value Store)

```bash
# List namespaces
wrangler kv namespace list

# List keys
wrangler kv key list --namespace-id <id>

# Get a key
wrangler kv key get --namespace-id <id> "mykey"

# Put a key
wrangler kv key put --namespace-id <id> "mykey" "myvalue"

# Delete a key
wrangler kv key delete --namespace-id <id> "mykey"
```

## R2 (Object Storage)

```bash
# List buckets
wrangler r2 bucket list

# Create bucket
wrangler r2 bucket create <name>

# List objects
wrangler r2 object list <bucket>

# Upload object
wrangler r2 object put <bucket>/<key> --file ./local-file.txt

# Download object
wrangler r2 object get <bucket>/<key> --file ./downloaded.txt
```

## Pages

```bash
# Deploy to Pages
wrangler pages deploy ./dist

# List projects
wrangler pages project list

# View deployment logs
wrangler pages deployment list --project-name=<name>
```

## Secrets

```bash
# List secrets
wrangler secret list

# Set a secret
wrangler secret put API_KEY

# Delete a secret
wrangler secret delete API_KEY
```

## Environment Variables

```bash
# List environment variables (non-secret)
wrangler env list

# Set environment variable
wrangler env put MY_VAR --value "myvalue"
```

## Common Patterns

### Check deployment status
```bash
wrangler deployments list
```

### View recent logs
```bash
wrangler tail --format json
```

### Run migrations
```bash
wrangler d1 execute mydb --file ./migrations/001.sql --remote
```

### Create and publish a Worker
```bash
wrangler init my-worker
cd my-worker
wrangler deploy
```

## Notes

- `--remote` flag operates on production, omit for local
- `--env <name>` targets a specific environment
- Long-running commands may timeout; increase config timeout if needed
