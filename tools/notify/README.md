# Notify Tool

Send push notifications via [ntfy.sh](https://ntfy.sh) or self-hosted ntfy servers.

## Overview

This tool allows AI agents to send push notifications to phones, desktops, and browsers. It's perfect for:

- Alerting when long tasks complete
- Notifying about errors or warnings
- Sending status updates
- Time-sensitive communications

## Installation

1. Install the [ntfy app](https://ntfy.sh) on your device (iOS, Android, or desktop)
2. Subscribe to a topic (or use the default random topic)
3. Configure the tool with your topic name

## Configuration

Add to your agent's config file (`~/.beige/config.json`):

```json
{
  "tools": {
    "notify": {
      "defaultTopic": "my-agent-alerts",
      "server": "https://ntfy.sh",
      "defaultPriority": "default",
      "allowTopics": ["alerts", "builds", "my-agent-alerts"],
      "token": "tk_xxxxx"
    }
  }
}
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `defaultTopic` | string | Default topic to send notifications to |
| `server` | string | ntfy server URL (default: `https://ntfy.sh`) |
| `defaultPriority` | string | Default priority: `min`, `low`, `default`, `high`, `urgent` |
| `allowTopics` | string[] | If set, only these topics can be used |
| `denyTopics` | string[] | Topics that cannot be used |
| `token` | string | Access token for protected topics |

## Usage

### Basic Usage

```sh
# Send a simple notification
notify --message "Task complete!"

# With title
notify --message "Build finished" --title "CI"

# With priority
notify --message "Critical error!" --priority urgent --title "Alert"
```

### With Tags and Emoji

```sh
# Add tags for categorization
notify --message "Check the logs" --tags warning,logs

# Add emoji (can use emoji name or actual emoji)
notify --message "Deploy complete" --emoji partying_face
notify --message "Error occurred" --emoji "🚨"
```

### With Actions

```sh
# Add clickable link
notify --message "View results" --click "https://example.com/results"

# Add attachment
notify --message "See attached file" --attach "https://example.com/report.pdf"
```

### Scheduled Delivery

```sh
# Delay delivery
notify --message "Meeting in 30 minutes" --delay "30min"
notify --message "Morning reminder" --delay "tomorrow, 9am"
```

### Custom Server

```sh
# Use self-hosted ntfy server
notify --message "Hello" --server "https://ntfy.mycompany.com"
```

## Command Reference

| Option | Short | Description |
|--------|-------|-------------|
| `--message <text>` | `-m` | Notification message (required) |
| `--topic <name>` | `-t` | Topic to send to (uses default if not specified) |
| `--title <text>` | `-T` | Notification title |
| `--priority <level>` | `-p` | Priority: `min`, `low`, `default`, `high`, `urgent` (or 1-5) |
| `--tags <tags>` | | Comma-separated tags |
| `--emoji <emoji>` | `-e` | Emoji for notification |
| `--click <url>` | `-c` | URL to open when clicked |
| `--attach <url>` | `-a` | URL of attachment |
| `--delay <duration>` | `-d` | Delay delivery |
| `--actions <json>` | | JSON action buttons (advanced) |
| `--server <url>` | `-s` | Override ntfy server |
| `--token <token>` | | Access token for protected topics |
| `--quiet` | `-q` | Only output message ID on success |
| `--help` | `-h` | Show help |

## Priority Levels

| Level | Number | Use Case |
|-------|--------|----------|
| `min` | 5 | Low-priority info |
| `low` | 4 | Non-urgent updates |
| `default` | 3 | Normal notifications |
| `high` | 2 | Important alerts |
| `urgent` | 1 | Critical alerts |

## Security

### Topic Access Control

Use `allowTopics` and `denyTopics` to control which topics the agent can use:

```json
{
  "tools": {
    "notify": {
      "defaultTopic": "agent-alerts",
      "allowTopics": ["agent-alerts", "builds"]
    }
  }
}
```

### Access Tokens

For protected topics, use an access token:

```json
{
  "tools": {
    "notify": {
      "defaultTopic": "private-alerts",
      "token": "tk_xxxxx"
    }
  }
}
```

## About ntfy.sh

ntfy.sh is a free, open-source notification service:
- No signup required (just pick a topic name)
- End-to-end encryption available
- Self-hostable
- Apps for iOS, Android, and desktop
- Web push notifications

Learn more at [ntfy.sh](https://ntfy.sh).

## Examples for AI Agents

```sh
# Notify when long task completes
notify -m "Data processing complete" -T "Pipeline"

# Alert on error
notify -m "Failed to connect to database" -p high -T "Error" --emoji warning

# Notify with link to results
notify -m "Report generated" -c "https://reports.example.com/latest"

# Low-priority status update
notify -m "Still running..." -p low

# Urgent alert
notify -m "Disk space critical: 95% used" -p urgent --emoji rotatzing_light
```

## License

MIT
