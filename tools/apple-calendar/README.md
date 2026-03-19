# Apple Calendar Tool

Read events from macOS Calendar (Apple Calendar). The tool uses a compiled
Swift binary that reads directly from the EventKit store — it does **not**
launch Calendar.app, making it fast (~0.1–0.5s per query).

Supports all calendar sources configured in macOS: iCloud, Google, Exchange,
CalDAV, subscribed calendars, birthdays, etc.

**Read-only** — no event creation or modification.

## Requirements

- **macOS** (EventKit is an Apple framework)
- **Xcode Command Line Tools** — needed to compile the Swift binary on first use.
  Install with: `xcode-select --install`
- **Calendar access permission** — macOS will prompt once to grant Calendar
  access to the binary. Approve in System Settings → Privacy & Security →
  Calendars.

## Usage

```sh
/tools/bin/apple-calendar <subcommand> [args...]
```

All output is **JSON**. Dates use `yyyy-MM-dd` format for input and ISO 8601
for output.

## Commands

### List calendars

```sh
# List all calendars with their source, type, and colour
/tools/bin/apple-calendar calendars
```

Output:
```json
[
  {
    "title": "Main Calendar",
    "source": "iCloud",
    "type": "caldav",
    "color": "#1badf8",
    "immutable": false
  },
  {
    "title": "Work",
    "source": "Google",
    "type": "caldav",
    "color": "#7ae7bf",
    "immutable": false
  },
  {
    "title": "Birthdays",
    "source": "Other",
    "type": "birthday",
    "color": "#8295af",
    "immutable": true
  }
]
```

### Events today

```sh
/tools/bin/apple-calendar events today
```

### Events tomorrow

```sh
/tools/bin/apple-calendar events tomorrow
```

### Events for a specific date

```sh
/tools/bin/apple-calendar events date 2026-03-20
```

### Events in a date range

```sh
# Inclusive range — shows events from March 18 through March 21
/tools/bin/apple-calendar events range 2026-03-18 2026-03-21
```

### Search events

```sh
# Search by title, notes, or location (case-insensitive)
# Default range: 30 days ago to 30 days from now
/tools/bin/apple-calendar events search "standup"

# With explicit date range
/tools/bin/apple-calendar events search "standup" --from 2026-03-01 --to 2026-03-31
```

### Event output format

Each event is a JSON object with the following fields:

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
| `attendees` | array | | `[{ name, email, status }]` — status is one of: accepted, declined, tentative, pending, delegated, completed, in-process, unknown |

Example:
```json
{
  "title": "EXO/P13N Standup",
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

## Access control

Restrict which subcommands an agent may use via the tool's `config` block:

| Config field | Type | Default | Description |
|---|---|---|---|
| `allowedCommands` | `string \| string[]` | all | Only these command paths are permitted. Prefix matching. |
| `deniedCommands` | `string \| string[]` | *(none)* | Always blocked. Deny beats allow. Prefix matching. |
| `timeout` | `number` | `10` | Timeout in seconds per calendar-cli invocation. |
| `binaryPath` | `string` | auto-detected | Override path to the compiled calendar-cli binary. |

A **command path** is the leading 1–2 subcommand tokens:

| Args | Command path |
|---|---|
| `calendars` | `calendars` |
| `events today` | `events today` |
| `events date 2026-03-20` | `events date` |
| `events search "standup" --from ...` | `events search` |
| `events range 2026-03-18 2026-03-21` | `events range` |

Matching is by **prefix**: `"events"` in a deny list blocks `events today`,
`events date`, `events range`, `events search`, and `events tomorrow`.

### Config examples

**Today-only agent** (can only see today's events):
```json5
config: {
  allowedCommands: ["events today"],
}
```

**Full read access** (default — no config needed):
```json5
config: {}
```

**Everything except search** (deny search, allow all others):
```json5
config: {
  deniedCommands: ["events search"],
}
```

**Schedule viewer** (today + tomorrow + specific dates, no search/range):
```json5
config: {
  allowedCommands: ["events today", "events tomorrow", "events date", "calendars"],
}
```

When a denied command is called, the tool exits with code `1`:
```
Permission denied: command 'events search' is blocked by deniedCommands ('events search')
```

## Binary compilation

The tool bundles a Swift source file (`calendar-cli.swift`). On first
invocation, if no compiled binary is found, the handler compiles it
automatically using `swiftc`. This requires Xcode Command Line Tools.

Compilation happens once and takes ~5–10 seconds. Subsequent calls use the
cached binary (~0.1–0.5s per query).

To compile manually:
```sh
cd tools/calendar
swiftc calendar-cli.swift -o calendar-cli -O
```

To use a pre-compiled binary at a custom location:
```json5
config: {
  binaryPath: "/usr/local/bin/calendar-cli",
}
```

## Notes

- The tool is **read-only** — it cannot create, modify, or delete events.
- The binary reads from the EventKit store, which syncs with all configured
  calendar accounts (iCloud, Google, Exchange, etc.).
- No credentials are stored in Beige config. Calendar access is managed
  entirely by macOS privacy settings.
- The tool is stateless — each invocation spawns a fresh process.
- All output is JSON — pipe through `jq` for pretty-printing if needed.
- All-day events may show start/end times offset by timezone (EventKit
  stores them in UTC internally).

## Error reference

| Error | Cause |
|---|---|
| `calendar-cli binary not found` | Binary not compiled yet and swiftc not available |
| `Calendar access denied` | macOS Calendar permission not granted |
| `Invalid date format` | Date not in yyyy-MM-dd format |
| `End date must be after start date` | Range end is before or equal to start |
| `(no output)` | calendar-cli ran but returned nothing (unlikely) |

## Implementation details

- **Target**: Gateway (runs on the host, not in the sandbox)
- **Dependency**: Xcode Command Line Tools (for compilation), macOS EventKit
- **Binary**: `calendar-cli` — compiled Swift, reads EventKit store directly
- **Protocol**: Tool launcher calls back to gateway via Unix socket
- **Source**: `tools/apple-calendar/index.ts` (handler) + `tools/apple-calendar/calendar-cli.swift` (CLI)
