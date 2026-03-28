# Brave Search Plugin for Beige

A Beige plugin that provides web search capabilities using the [Brave Search API](https://brave.com/search/api/).

## Features

- 🚀 Fast, privacy-focused web search
- 🌍 Country-specific search results
- 🔢 Configurable result limits
- 📄 Pagination support
- 🎯 Simple, clean interface

## Installation

This plugin is part of the beige-toolkit. Install the toolkit to get access:

```bash
npm install @matthias-hausberger/beige
```

## Configuration

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

### Getting an API Key

1. Visit [https://brave.com/search/api/](https://brave.com/search/api/)
2. Create an account
3. Choose a Search plan (free tier available)
4. Generate an API key from the dashboard

### Environment Variable

Alternatively, set the `BRAVE_API_KEY` environment variable and the plugin will use it automatically:

```bash
export BRAVE_API_KEY="your-api-key-here"
```

## Usage

The plugin provides a `brave` tool that agents can use to perform web searches.

### Examples

**Basic search:**
```
brave search "cloudflare workers documentation"
```

**Limit results:**
```
brave search "rust programming" --count 3
```

**Country-specific search:**
```
brave search "news today" --country DE
```

**Pagination:**
```
brave search "machine learning" --offset 10
```

## Available Commands

| Command | Description |
|---------|-------------|
| `search <query>` | Search the web with a query |
| `search <query> --count <n>` | Limit results (1-20, default: 5) |
| `search <query> --country <code>` | Country-specific results (e.g., US, DE, GB) |
| `search <query> --offset <n>` | Pagination offset (default: 0) |

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | required | Brave Search API key |
| `maxResults` | number | 5 | Default maximum results (1-20) |
| `timeoutSeconds` | number | 30 | Request timeout in seconds |

## Output Format

Results are formatted for easy reading:

```
🔍 Found 3 results for "cloudflare workers"

1. Cloudflare Workers Documentation
   https://developers.cloudflare.com/workers/
   Build serverless applications with Cloudflare Workers. Run JavaScript and...

2. What are Cloudflare Workers?
   https://www.cloudflare.com/learning/serverless/what-is-cloudflare-workers/
   Cloudflare Workers is a serverless platform that allows you to deploy...
```

## API Limits

- The Brave Search API is rate-limited based on your plan
- Free tier typically includes ~2,000 queries/month
- Be mindful of usage when running automated searches

## Privacy

Brave Search is privacy-focused:
- Does not track users
- Does not store personal data
- This plugin sends queries directly to Brave's API
- No search history is stored by the plugin

## Development

Based on the Brave Search API documentation:
- [Brave Search API](https://brave.com/search/api/)
- [OpenClaw Brave Search Implementation](https://github.com/openclaw/openclaw) (reference)

## License

MIT
