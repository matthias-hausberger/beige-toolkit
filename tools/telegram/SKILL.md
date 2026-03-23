# Telegram Tool — Usage Guide

Send messages, photos, and documents to Telegram users and groups via the Bot API.

## Calling Convention

```sh
/tools/bin/telegram <subcommand> [options]
```

## Quick Examples

### Send a Message

```sh
# Send to specific user
/tools/bin/telegram send --chat 58687206 --text "Hello from beige!"

# With default chat configured, just:
/tools/bin/telegram send --text "Hello!"

# Formatted message
/tools/bin/telegram send --chat 58687206 --text "*Bold* _italic_" --parse-mode Markdown
```

### Send Media

```sh
# Photo by URL
/tools/bin/telegram photo --chat 58687206 --photo https://example.com/image.jpg

# Photo with caption
/tools/bin/telegram photo --chat 58687206 --photo https://example.com/image.jpg --caption "Check this out!"

# Document
/tools/bin/telegram document --chat 58687206 --document https://example.com/report.pdf
```

### Threads and Replies

```sh
# Post to a topic/thread in a supergroup
/tools/bin/telegram send --chat -1001234567890 --text "Topic post" --thread 42

# Reply to a specific message
/tools/bin/telegram send --chat 58687206 --text "Reply!" --reply-to 12345
```

### Get Info

```sh
# Get bot info
/tools/bin/telegram me

# Get chat info
/tools/bin/telegram chat --chat 58687206

# Get pending updates
/tools/bin/telegram updates --limit 10
```

## Subcommands

| Subcommand | Aliases | Description |
|------------|---------|-------------|
| `send` | `message`, `msg` | Send a text message |
| `photo` | `image`, `img` | Send a photo |
| `document` | `doc`, `file` | Send a document |
| `me` | `bot`, `self` | Get bot information |
| `chat` | `info` | Get chat information |
| `updates` | `poll` | Get pending updates |

## Options

### Send Options

| Option | Type | Description |
|--------|------|-------------|
| `--chat` | number | Chat/user ID (required unless defaultChatId configured) |
| `--text` | string | Message text to send |
| `--thread` | number | Thread/topic ID for supergroups |
| `--reply-to` | number | Message ID to reply to |
| `--parse-mode` | string | Formatting: `Markdown`, `MarkdownV2`, or `HTML` |
| `--silent` | flag | Send without notification sound |
| `--disable-preview` | flag | Disable web page preview for links |

### Photo Options

| Option | Type | Description |
|--------|------|-------------|
| `--chat` | number | Chat/user ID |
| `--photo` | string | Photo URL or file_id |
| `--caption` | string | Photo caption |
| `--thread` | number | Thread/topic ID |
| `--reply-to` | number | Message ID to reply to |

### Document Options

| Option | Type | Description |
|--------|------|-------------|
| `--chat` | number | Chat/user ID |
| `--document` | string | Document URL or file_id |
| `--caption` | string | Document caption |
| `--thread` | number | Thread/topic ID |
| `--reply-to` | number | Message ID to reply to |

### Updates Options

| Option | Type | Description |
|--------|------|-------------|
| `--limit` | number | Maximum number of updates to retrieve |
| `--offset` | number | Identifier of first update to return |

## Formatting

### Markdown

```sh
/tools/bin/telegram send --chat 58687206 --text "*bold* _italic_ [link](https://example.com)" --parse-mode Markdown
```

### HTML

```sh
/tools/bin/telegram send --chat 58687206 --text "<b>bold</b> <i>italic</i> <a href='https://example.com'>link</a>" --parse-mode HTML
```

### MarkdownV2

Note: Requires escaping special characters.

```sh
/tools/bin/telegram send --chat 58687206 --text "*bold* _italic_ \`code\`" --parse-mode MarkdownV2
```

## Thread/Topic Support

For supergroups with Topics enabled, use `--thread` to post to a specific topic:

```sh
/tools/bin/telegram send --chat -1001234567890 --text "Topic message" --thread 42
```

## Error Messages

| Error | Cause |
|-------|-------|
| `No chat ID specified` | Missing `--chat` and no `defaultChatId` configured |
| `No message text specified` | Missing `--text` for send command |
| `botToken not configured` | Tool missing required `botToken` config |
| `Permission denied: Chat X is in deny list` | Chat ID blocked by `denyChats` |
| `Permission denied: Chat X is not in allow list` | Chat ID not in `allowChats` whitelist |
| `Telegram API error: Bad Request: chat not found` | Invalid chat ID or bot not in chat |

## Tips

- Configure `defaultChatId` for your primary contact to simplify commands
- Use `--silent` for non-urgent notifications
- Use `--parse-mode Markdown` for simple formatting
- Call `telegram updates` to discover chat IDs after adding bot to groups
- Use `allowChats` to restrict which chats the bot can message
