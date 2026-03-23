# HTTP Fetch Tool

Make HTTP requests to external APIs and services from Beige agents.

## Features

- **Multiple HTTP methods** - GET, POST, PUT, DELETE
- **Custom headers** - Add any headers you need
- **Configurable timeout** - Don't hang on slow requests
- **Domain filtering** - Allow/deny list for security
- **Response size limits** - Prevent memory issues

## Commands

```bash
# GET request
http get https://api.example.com/data

# GET with headers
http get https://api.example.com/data --header Authorization="Bearer token"

# POST with JSON body
http post https://api.example.com/users --header Content-Type=application/json -- '{"name":"Alice"}'

# PUT request
http put https://api.example.com/users/1 --header Authorization="Bearer token" -- '{"name":"Bob"}'

# DELETE request
http delete https://api.example.com/users/1 --header Authorization="Bearer token"

# With custom timeout
http get https://slow-api.example.com/data --timeout 60
```

## Configuration

Add to your agent's config:

```json5
{
  tools: {
    http: {
      config: {
        allowDomains: ["api.example.com", "internal.company.com"],
        defaultTimeout: 30,
        maxResponseSize: 1048576, // 1MB
      },
    },
  },
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowDomains` | string \| string[] | (all) | Whitelist of allowed domains |
| `denyDomains` | string \| string[] | (none) | Blacklist of blocked domains |
| `defaultTimeout` | number | 30 | Default timeout in seconds |
| `maxResponseSize` | number | 1048576 | Max response size in bytes (1MB) |

## Security

- Domain filtering prevents requests to unauthorized hosts
- Response size limits prevent memory exhaustion
- Timeouts prevent hanging on slow/unresponsive servers
- All requests are logged for audit purposes

## Response Format

```
HTTP GET https://api.example.com/data
Status: 200 OK
Headers:
  content-type: application/json
  x-request-id: abc123

Body:
{"status": "ok", "data": [...]}
```

## Error Handling

- Non-2xx status codes return exit code 1
- Timeouts return a clear error message
- Domain filtering violations are rejected immediately
- Response size violations truncate and warn

## Use Cases

- Fetch data from REST APIs
- Send webhooks
- Check website status
- Download content from URLs
- Interact with external services
