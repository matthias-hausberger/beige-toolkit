# Apple Calendar Tool — Usage Guide

Read events from macOS Calendar. Supports all calendar sources (iCloud, Google, Exchange, subscribed, etc.). **Read-only** — no event creation or modification.

## Calling Convention

```sh
/tools/bin/apple-calendar <subcommand> [args...]
```

All output is **JSON**. Dates use `yyyy-MM-dd` format for input and ISO 8601 for output.

## Examples

### List Calendars

```sh
/tools/bin/apple-calendar calendars
```

Returns all calendars with their source, type, and colour.

### View Events

```sh
# Today's events
/tools/bin/apple-calendar events today

# Tomorrow's events
/tools/bin/apple-calendar events tomorrow

# Specific date
/tools/bin/apple-calendar events date 2026-03-20

# Date range (inclusive)
/tools/bin/apple-calendar events range 2026-03-18 2026-03-21
```

### Search Events

```sh
# Search by title, notes, or location (case-insensitive)
# Default: 30 days ago to 30 days from now
/tools/bin/apple-calendar events search "standup"

# With explicit date range
/tools/bin/apple-calendar events search "standup" --from 2026-03-01 --to 2026-03-31
```

## Event Output Format

Each event is a JSON object:

| Field | Type | Always present | Description |
|---|---|---|---|
| `title` | string | ✓ | Event title |
| `start` | string | ✓ | ISO 8601 start time |
| `end` | string | ✓ | ISO 8601 end time |
| `allDay` | boolean | ✓ | Whether the event is all-day |
| `calendar` | string | ✓ | Calendar name |
| `calendarSource` | string | ✓ | Calendar source (e.g. "iCloud", "Google") |
| `location` | string | | Event location |
| `notes` | string | | Event notes/description |
| `url` | string | | Event URL |
| `recurring` | boolean | | Present and `true` for recurring events |
| `organizer` | object | | `{ name, email }` of the organizer |
| `attendees` | array | | `[{ name, email, status }]` — status: accepted, declined, tentative, pending, delegated, completed, in-process, unknown |

Example:
```json
{
  "title": "Team Standup",
  "start": "2026-03-19T09:15:00",
  "end": "2026-03-19T09:30:00",
  "allDay": false,
  "calendar": "Work",
  "calendarSource": "Google",
  "location": "https://zoom.us/j/123456789",
  "recurring": true,
  "organizer": {
    "name": "Alice Smith",
    "email": "alice@example.com"
  },
  "attendees": [
    { "name": "Alice Smith", "email": "alice@example.com", "status": "accepted" },
    { "name": "Bob Jones", "email": "bob@example.com", "status": "tentative" }
  ]
}
```

## Permission Errors

If a command is denied, you'll see:
```
Permission denied: command 'events search' is blocked by deniedCommands ('events search')
```

## Tips

- Use `events today` as the most common starting point.
- All-day events may show start/end times offset by timezone (EventKit stores them in UTC internally).
- Pipe output through `jq` for pretty-printing if needed.
- The tool is stateless — each invocation spawns a fresh process.
