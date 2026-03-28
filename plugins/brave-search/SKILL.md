# Brave Search Plugin

Search the web using the Brave Search API from within the Beige agent system.

## Setup

### Get an API Key

1. Visit [https://brave.com/search/api/](https://brave.com/search/api/)
2. Create an account and choose a Search plan
3. Generate an API key from the dashboard
4. Add the key to your agent config

### Configure the Plugin

Add to your agent configuration:

```json
{
  "plugins": {
    "brave-search": {
      "config": {
        "apiKey": "YOUR_BRAVE_API_KEY_HERE",
        "maxResults": 5,
        "timeoutSeconds": 30
      }
    }
  }
}
```

Or set the `BRAVE_API_KEY` environment variable and the plugin will use it automatically.

## Usage

The Brave Search plugin provides a `brave-search` tool that agents can use to perform web searches.

### Basic Search

```
brave-search search "what is cloudflare workers"
```

### Limit Results

```
brave-search search "typescript best practices" --count 3
```

### Country-Specific Search

```
brave-search search "news today" --country DE
```

### Pagination

```
brave-search search "rust programming" --offset 10
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `search <query>` | Search the web with a query |
| `search <query> --count <n>` | Limit results (1-20, default: 10) |
| `search <query> --country <code>` | Country-specific results (e.g., US, DE, GB) |
| `search <query> --offset <n>` | Pagination offset (default: 0) |

**Tool name**: `brave-search`

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | required | Brave Search API key |
| `maxResults` | number | 10 | Default maximum results (1-20) |
| `timeoutSeconds` | number | 30 | Request timeout in seconds |

**Tool name**: `brave-search` (not `brave`)

## Output Format

Results are returned as formatted text with:

- Title of each result
- URL
- Description/snippet
- Age (when available)

Example output:

```
🔍 Found 5 results for "cloudflare workers"

1. Cloudflare Workers Documentation
   https://developers.cloudflare.com/workers/
   Build serverless applications with Cloudflare Workers...

2. What are Cloudflare Workers?
   https://www.cloudflare.com/learning/serverless/what-is-cloudflare-workers/
   Cloudflare Workers is a serverless platform that allows...

...
```

## API Limits

- The Brave Search API is rate-limited based on your plan
- Free tier typically includes ~2,000 queries/month
- Be mindful of usage when running automated searches

## Privacy

Brave Search is privacy-focused and does not track users. This plugin sends queries directly to Brave's API and does not store search history.
