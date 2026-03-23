# Telegram Tool

Send messages, photos, documents, and more to Telegram users and groups from Beige agents.

## Features

- **Text messages** - Send formatted text with Markdown or HTML
- **Photos** - Send images by URL or file_id
- **Documents** - Send files by URL or file_id
- **Thread support** - Post to specific topics in supergroups
- **Reply-to** - Reply to specific messages
- **Silent mode** - Send without notification
- **Link preview control** - Disable web page previews
- **Chat filtering** - Allow/deny list for security
- **Bot info** - Get bot details and chat information

## Installation

Install this tool individually:

```bash
beige tools install github:matthias-hausberger/beige-toolkit/tools/telegram
```

Or install all tools from the toolkit:

```bash
# From npm
beige tools install npm:@matthias-hausberger/beige-toolkit

# From GitHub
beige tools install github:matthias-hausberger/beige-toolkit
```

## Configuration

Add to your agent's config:

```json5
{
  tools: {
    telegram: {
      config: {
        botToken: "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz",
        defaultChatId: "58687206",
        defaultParseMode: "MarkdownV2",
        allowChats: ["58687206", "-1001234567890"],
      },
    },
  },
}
```

### Config Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `botToken` | string | **Yes** | Telegram Bot API token from @BotFather |
| `defaultChatId` | string \| number | No | Default chat/user ID to send to |
| `defaultParseMode` | string | No | Default formatting: `MarkdownV2`, `Markdown`, `HTML` |
| `allowChats` | array | No | Whitelist of allowed chat IDs |
| `denyChats` | array | No | Blacklist of blocked chat IDs (deny beats allow) |
| `timeout` | number | No | Request timeout in seconds (default: 30) |

### Getting Your Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the instructions
3. Copy the token provided (format: `1234567890:ABCdef...`)

### Getting Chat IDs

For **private chats**, your user ID is shown by bots like [@userinfobot](https://t.me/userinfobot).

For **groups/supergroups**, add the bot to the group and use:
```
telegram updates --limit 10
```
Look for the `chat.id` in the response.

## Commands

### Send a Text Message

```bash
# Basic message
telegram send --chat 58687206 --text "Hello from beige!"

# With default chat configured
telegram send --text "Hello!"

# Markdown formatting
telegram send --chat 58687206 --text "*Bold* and _italic_" --parse-mode Markdown

# Reply to a message
telegram send --chat 58687206 --text "Reply!" --reply-to 12345

# Post to a thread/topic (supergroups)
telegram send --chat -1001234567890 --text "Topic message" --thread 42

# Silent (no notification)
telegram send --chat 58687206 --text "Quiet message" --silent

# Disable link previews
telegram send --chat 58687206 --text "Check https://example.com" --disable-preview
```

### Send a Photo

```bash
# By URL
telegram photo --chat 58687206 --photo https://example.com/image.jpg

# With caption
telegram photo --chat 58687206 --photo https://example.com/image.jpg --caption "Check this out!"

# Reply to message
telegram photo --chat 58687206 --photo https://example.com/image.jpg --reply-to 12345

# Post to thread
telegram photo --chat -1001234567890 --photo https://example.com/image.jpg --thread 42
```

### Send a Document

```bash
# By URL
telegram document --chat 58687206 --document https://example.com/file.pdf

# With caption
telegram document --chat 58687206 --document https://example.com/report.pdf --caption "Monthly report"

# Post to thread
telegram document --chat -1001234567890 --document https://example.com/file.pdf --thread 42
```

### Get Bot Info

```bash
telegram me
```

Returns:
```json
{
  "id": 1234567890,
  "is_bot": true,
  "first_name": "Beige Bot",
  "username": "beige_bot",
  "can_join_groups": true,
  "can_read_all_group_messages": false
}
```

### Get Chat Info

```bash
telegram chat --chat 58687206
```

Returns chat details including type, title (for groups), username, etc.

### Get Updates

```bash
# Get recent updates
telegram updates

# Limit number of updates
telegram updates --limit 10

# Get updates starting from a specific offset
telegram updates --offset 100
```

## Thread/Topic Support

For supergroups with [Topics](https://telegram.org/blog/topics-in-groups) enabled:

```bash
# Post to a specific topic
telegram send --chat -1001234567890 --text "Topic message" --thread 42
```

The `--thread` flag sets `message_thread_id` in the API call.

## Formatting

### MarkdownV2 (recommended)

```bash
telegram send --chat 58687206 --text "*bold* _italic_ \`code\`" --parse-mode MarkdownV2
```

Note: MarkdownV2 requires escaping certain characters. See [Telegram API docs](https://core.telegram.org/bots/api#markdownv2-style).

### Markdown

```bash
telegram send --chat 58687206 --text "*bold* _italic_ [link](https://example.com)" --parse-mode Markdown
```

### HTML

```bash
telegram send --chat 58687206 --text "<b>bold</b> <i>italic</i> <a href='https://example.com'>link</a>" --parse-mode HTML
```

## Security

### Chat Filtering

Control which chats the bot can message:

```json5
// Only allow specific chats
config: {
  allowChats: ["58687206", "-1001234567890"],
}

// Block specific chats
config: {
  denyChats: ["-1009999999999"],
}

// Combine: allow all except blocked
config: {
  denyChats: ["-1009999999999"],
}
```

**Precedence:** `denyChats` takes priority over `allowChats`.

### Best Practices

1. **Store bot token securely** - Use environment variables or secret management
2. **Use allowChats** - Restrict which chats can receive messages
3. **Validate user input** - Be careful with user-provided message content
4. **Handle rate limits** - Telegram has rate limits; implement backoff if needed

## Use Cases

- **Notifications** - Alert users about events, deploys, errors
- **Cron job alerts** - Send scheduled status updates
- **Interactive bots** - Respond to user commands
- **Report delivery** - Send daily/weekly reports
- **Monitoring alerts** - Alert on system issues
- **CI/CD notifications** - Notify on build status

## Error Handling

The tool returns clear error messages:

```
Error: No chat ID specified. Use --chat or configure defaultChatId.
```

```
Telegram API error: Bad Request: chat not found (code 400)
```

```
Permission denied: Chat -1001234567890 is in deny list
```

## API Reference

This tool uses the [Telegram Bot API](https://core.telegram.org/bots/api). Supported methods:

- `sendMessage` - Send text messages
- `sendPhoto` - Send photos
- `sendDocument` - Send documents
- `getMe` - Get bot info
- `getChat` - Get chat info
- `getUpdates` - Get pending updates

## License

MIT
