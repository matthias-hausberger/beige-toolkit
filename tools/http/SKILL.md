# HTTP Tool — Usage Guide

Make HTTP requests to external APIs and services. Supports GET, POST, PUT, and DELETE methods with custom headers and configurable timeouts.

## Quick Start

```bash
# Simple GET request
http get https://api.github.com/repos/Matthias-Hausberger/beige

# With authentication
http get https://api.example.com/data --header "Authorization=Bearer YOUR_TOKEN"

# POST JSON data
http post https://api.example.com/users -- '{"name":"Alice","email":"alice@example.com"}'
```

## Command Reference

### GET Request

```bash
http get <url> [--header <key=value>]... [--timeout <seconds>]
```

### POST Request

```bash
http post <url> [--header <key=value>]... [--timeout <seconds>] [-- <body>]
```

### PUT Request

```bash
http put <url> [--header <key=value>]... [--timeout <seconds>] [-- <body>]
```

### DELETE Request

```bash
http delete <url> [--header <key=value>]... [--timeout <seconds>]
```

## Common Patterns

### Fetch JSON API

```bash
http get https://api.example.com/users --header "Accept=application/json"
```

### Submit Form Data

```bash
http post https://api.example.com/submit --header "Content-Type=application/x-www-form-urlencoded" -- "name=Alice&email=alice%40example.com"
```

### API with Authentication

```bash
http get https://api.example.com/protected --header "Authorization=Bearer YOUR_TOKEN"
```

### Webhook

```bash
http post https://hooks.example.com/trigger --header "Content-Type=application/json" -- '{"event":"deploy","status":"success"}'
```

### Health Check

```bash
http get https://example.com/health --timeout 5
```

## Response Handling

The tool returns:

1. **Request info** - Method and URL
2. **Status** - HTTP status code and message
3. **Headers** - All response headers
4. **Body** - Response content (truncated if too large)

Exit codes:
- `0` - Successful (2xx status)
- `1` - Failed (non-2xx or error)

## Tips

- Use `--timeout` for slow APIs to avoid hanging
- Add `Accept: application/json` header for JSON APIs
- Check domain allow/deny lists if requests fail
- Large responses are truncated (check maxResponseSize config)
- Use quotes around header values with special characters

## Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `Domain 'x' is in deny list` | Domain blocked by config | Use allowed domain or request config change |
| `Domain 'x' is not in allow list` | Domain not in whitelist | Add domain to allow list or request access |
| `Request timed out` | Server didn't respond in time | Increase timeout or check server |
| `Response too large` | Response exceeded size limit | Increase maxResponseSize or filter response |
| `Invalid URL` | Malformed URL | Check URL format |
