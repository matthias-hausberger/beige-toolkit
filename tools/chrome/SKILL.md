# Chrome Tool — Usage Guide

Control a Chrome browser. Supports navigation, DOM inspection, JavaScript evaluation, screenshots, network monitoring, performance analysis, and more.

Each agent gets its own **persistent Chrome profile** — cookies, logins, and localStorage survive gateway restarts.

## Calling Convention

```sh
/tools/bin/chrome <tool_name> [--flag value | '{json params}']
```

Two calling styles:

**Flag-style** (simple values):
```sh
chrome navigate_page --url https://example.com
chrome click --uid button-42
```

**JSON params** (structured / nested data):
```sh
chrome fill_form '{"elements":[{"uid":"u1","value":"alice"},{"uid":"u2","value":"pass"}]}'
chrome evaluate_script '{"function":"() => document.querySelectorAll(\"a\").length"}'
```

## Quick Start Workflow

1. **Navigate** to a page
2. **Snapshot** to see the accessibility tree (cheap, gives you element uids)
3. **Interact** using uids from the snapshot
4. **Screenshot** only when you need visual confirmation

```sh
chrome navigate_page --url https://example.com
chrome take_snapshot
chrome click --uid link-42
chrome take_screenshot
```

> **Always prefer `take_snapshot` over `take_screenshot`** — it's much cheaper in tokens and gives you element uids for interaction.

## Available Tools

Run `chrome --list-tools` to see the live list from the running MCP server.

For detailed guides on specific capabilities, see:
- [Navigation & Page Management](skills/navigation.md)
- [DOM Inspection & Interaction](skills/interaction.md)
- [Network & Performance](skills/network-performance.md)

### Tool Reference

| Tool | Description |
|---|---|
| `take_snapshot` | Accessibility tree snapshot (use this first) |
| `take_screenshot` | Screenshot saved to `/workspace/media/inbound/` |
| `navigate_page` | Go to a URL, or back/forward/reload |
| `new_page` | Open a new tab |
| `list_pages` | List all open tabs |
| `select_page` | Switch to a different tab |
| `close_page` | Close a tab |
| `click` | Click an element (uid from snapshot) |
| `drag` | Drag one element onto another |
| `fill` | Type into an input or select an option |
| `fill_form` | Fill multiple form fields at once |
| `type_text` | Type text into currently focused input |
| `press_key` | Press a key or key combination |
| `hover` | Hover over an element |
| `handle_dialog` | Accept or dismiss a browser dialog |
| `upload_file` | Upload a file through a file input |
| `wait_for` | Wait until text appears on the page |
| `evaluate_script` | Evaluate JavaScript in the page |
| `list_console_messages` | List browser console messages |
| `get_console_message` | Get a specific console message |
| `list_network_requests` | List network requests since last navigation |
| `get_network_request` | Get details of a specific request |
| `performance_start_trace` | Start a performance trace |
| `performance_stop_trace` | Stop trace and get results |
| `performance_analyze_insight` | Analyze a specific performance insight |
| `take_memory_snapshot` | Take a memory heap snapshot |
| `lighthouse_audit` | Lighthouse accessibility/SEO/best-practices audit |
| `emulate` | Emulate dark mode, network conditions, geolocation, user agent |
| `resize_page` | Resize the browser viewport |

> In `--slim` mode only `navigate`, `evaluate`, and `screenshot` are available.

## Screenshots

Screenshots are automatically saved to `/workspace/media/inbound/` with a timestamped filename. You don't need to specify `--filePath`:

```sh
chrome take_screenshot
# → Screenshot saved to: /media/inbound/screenshot-2026-03-17_22-14-00-000.png
```

## Permission Errors

If a tool is blocked by config, you'll see:

```
Permission denied: tool 'evaluate_script' is blocked by denyTools
```

## Tips

- The browser starts lazily on first call — no Chrome is launched just because the tool is configured.
- If Chrome crashes, the next call automatically starts a fresh browser.
- Use `list_pages` + `select_page` to manage multiple tabs.
- Use `evaluate_script` for complex DOM queries that `take_snapshot` doesn't cover.
- The browser profile persists at `~/.beige/browser-profiles/<agentName>/` — logins survive restarts.
