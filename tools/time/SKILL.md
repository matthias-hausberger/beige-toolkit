# Time Tool - Usage Guide

Quick reference for the time tool.

## Most Common Commands

```bash
# Current time
time now

# Unix timestamp
time now -f unix

# In a timezone
time now -t "America/New_York"
```

## Command Reference

| Command | Purpose | Example |
|---------|---------|---------|
| `now` | Current time | `time now -f datetime` |
| `format` | Format a date | `time format "2024-01-15" -f iso` |
| `parse` | Parse date string | `time parse "in 5 days"` |
| `add` | Add duration | `time add "now" 5d` |
| `subtract` | Subtract duration | `time subtract "now" 2h` |
| `diff` | Date difference | `time diff "date1" "date2"` |
| `start` | Start of period | `time start "now" week` |
| `end` | End of period | `time end "now" month` |
| `is` | Compare dates | `time is "d1" before "d2"` |
| `convert` | Change timezone | `time convert "now" "Europe/London"` |

## Formats

- `iso` - ISO 8601 (default)
- `unix` - Unix timestamp
- `datetime` - Human readable
- `YYYY-MM-DD` - Custom format

## Durations

`5s`, `10m`, `2h`, `3d`, `1w`, `6M`, `1y`

## Relative Dates

`now`, `in 5 days`, `2 hours ago`

## Quick Examples

```bash
# Current Unix timestamp
time now -f unix

# Add 7 days to now
time add "now" 7d

# Difference between dates
time diff "2024-01-01" "2024-12-31"

# Start of current week
time start "now" week

# Convert to timezone
time convert "now" "Europe/Berlin" -f datetime

# Check if date is before another
time is "2024-01-01" before "2024-12-31"
```
