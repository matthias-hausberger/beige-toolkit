# Telegram Plugin

You have access to Telegram messaging via the `telegram` tool.

## Sending Messages

To send a message to a Telegram chat:

```
telegram sendMessage <chatId> <text>
```

To send to a specific thread/topic in a group:

```
telegram sendMessage <chatId> --thread <threadId> <text>
```

## Examples

```bash
# Send a notification
telegram sendMessage 123456789 Build completed successfully!

# Send to a forum topic
telegram sendMessage -1001234567890 --thread 42 Deployment finished.
```

## Notes

- The `chatId` is a numeric Telegram chat ID (positive for users, negative for groups).
- Thread IDs are only relevant for Telegram groups with forum topics enabled.
- Messages longer than 4096 characters are automatically split.
