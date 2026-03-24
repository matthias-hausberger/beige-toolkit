# Time Tool

Time and date manipulation for the Beige agent toolkit.

## Overview

Provides comprehensive time and date operations:

- **Get current time**: With formatting and timezone support
- **Format dates**: Multiple output formats (ISO, Unix, RFC, custom)
- **Parse dates**: Convert any date string to multiple formats
- **Add/Subtract**: Date arithmetic with duration strings
- **Difference**: Calculate time between dates
- **Start/End of period**: Get boundaries of day, week, month, year
- **Compare dates**: Before, after, between, same checks
- **Timezone conversion**: Convert between timezones

## Installation

```bash
bun add tools/time
```

## Commands

### now

Get the current time.

```bash
time now
time now -f unix
time now -t "America/New_York" -f datetime
```

**Options:**
- `--format, -f <format>` - Output format
- `--timezone, -t <tz>` - Timezone (default: UTC)

### format

Format a date string.

```bash
time format "2024-01-15T10:30:00Z" -f "YYYY-MM-DD HH:mm:ss"
time format "now" -f datetime
```

### parse

Parse a date string to all available formats.

```bash
time parse "2024-01-15"
time parse "in 5 days"
time parse "2 hours ago"
```

Returns JSON with ISO, Unix, local, and UTC representations.

### add

Add a duration to a date.

```bash
time add "now" 5d
time add "2024-01-15" 2w
time add "now" 3h30m  # Note: currently only single unit
```

### subtract

Subtract a duration from a date.

```bash
time subtract "now" 2h
time subtract "2024-12-31" 1M
```

### diff

Calculate the difference between two dates.

```bash
time diff "2024-01-01" "2024-12-31"
time diff "now" "in 1 week"
```

Returns JSON with milliseconds, seconds, minutes, hours, days, weeks, months, years, and human-readable format.

### start

Get the start of a period.

```bash
time start "now" day
time start "2024-06-15" week
time start "now" month
time start "2024-06-15" year
```

**Periods:** second, minute, hour, day, week, month, year

### end

Get the end of a period.

```bash
time end "now" day
time end "2024-06-15" month
```

### is

Compare two dates.

```bash
time is "2024-01-01" before "2024-12-31"
time is "now" after "2024-01-01"
time is "2024-06-15" between "2024-01-01" "2024-12-31"
```

**Operations:**
- `before` / `<` - First date is before second
- `after` / `>` - First date is after second
- `same` / `==` - Dates are the same
- `before-or-same` / `<=` - First is before or same as second
- `after-or-same` / `>=` - First is after or same as second
- `between` - First is between second and third

### convert

Convert a date to a different timezone.

```bash
time convert "now" "Europe/London"
time convert "2024-01-15T12:00:00Z" "America/New_York" -f datetime
```

## Formats

| Format | Description | Example |
|--------|-------------|---------|
| `iso` | ISO 8601 (default) | 2024-01-15T10:30:00.000Z |
| `iso-date` | ISO date only | 2024-01-15 |
| `iso-time` | ISO time only | 10:30:00 |
| `unix` | Unix timestamp (seconds) | 1705315800 |
| `unix-ms` | Unix timestamp (ms) | 1705315800000 |
| `rfc2822` | RFC 2822 format | Mon, 15 Jan 2024 10:30:00 GMT |
| `rfc3339` | RFC 3339 format | 2024-01-15T10:30:00Z |
| `date` | Human-readable date | Jan 15, 2024 |
| `time` | Human-readable time | 10:30:00 AM |
| `datetime` | Human-readable datetime | Jan 15, 2024, 10:30:00 AM |
| `long` | Long format | January 15, 2024 at 10:30:00 AM UTC |
| `short` | Short format | 1/15/24, 10:30 AM |

### Custom Formats

Use format codes in custom strings:

| Code | Meaning | Example |
|------|---------|---------|
| `YYYY` | 4-digit year | 2024 |
| `YY` | 2-digit year | 24 |
| `MM` | 2-digit month | 01 |
| `M` | Month | 1 |
| `DD` | 2-digit day | 15 |
| `D` | Day | 15 |
| `HH` | Hour (24), 2-digit | 10 |
| `H` | Hour (24) | 10 |
| `hh` | Hour (12), 2-digit | 10 |
| `h` | Hour (12) | 10 |
| `mm` | Minute, 2-digit | 30 |
| `m` | Minute | 30 |
| `ss` | Second, 2-digit | 00 |
| `s` | Second | 0 |
| `A` | AM/PM | AM |
| `a` | am/pm | am |

Example: `YYYY-MM-DD HH:mm:ss` → `2024-01-15 10:30:00`

## Duration Syntax

Durations use the format `<number><unit>`:

| Unit | Meaning |
|------|---------|
| `ms` | Milliseconds |
| `s` | Seconds |
| `m` | Minutes |
| `h` | Hours |
| `d` | Days |
| `w` | Weeks |
| `M` | Months |
| `y` | Years |

Examples: `5s`, `10m`, `2h`, `3d`, `1w`, `6M`, `1y`

## Relative Dates

The tool supports natural language for relative dates:

| Expression | Meaning |
|------------|---------|
| `now` | Current time |
| `in 5 days` | 5 days from now |
| `in 2 hours` | 2 hours from now |
| `3 weeks ago` | 3 weeks before now |
| `1 year ago` | 1 year before now |

## Configuration

```json
{
  "defaultTimezone": "UTC",
  "defaultFormat": "iso",
  "allowedTimezones": []
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `defaultTimezone` | Default timezone | UTC |
| `defaultFormat` | Default output format | iso |
| `allowedTimezones` | Restrict timezones | all |

## Examples

### Get Unix timestamp

```bash
time now -f unix
# Output: 1705315800
```

### Calculate deadline

```bash
time add "now" 7d -f datetime
# Output: Jan 22, 2024, 10:30:00 AM
```

### Time until event

```bash
time diff "now" "2024-12-31T23:59:59Z"
# Output: { "days": 350, "hours": 13, "human": "50w 0d" }
```

### Check if date is in range

```bash
time is "2024-06-15" between "2024-01-01" "2024-12-31"
# Output: { "result": true }
```

### Convert timezone

```bash
time convert "2024-01-15T12:00:00Z" "America/New_York" -f datetime
# Output: Jan 15, 2024, 7:00:00 AM
```

## License

MIT
