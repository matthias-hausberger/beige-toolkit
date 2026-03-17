# chrome

Control a Chrome browser from within beige agents. Wraps [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) — giving agents full access to navigation, DOM inspection, JavaScript evaluation, screenshots, network monitoring, performance analysis, and more.

Each agent gets its own **persistent Chrome profile** — cookies, logins, and localStorage survive gateway restarts. The `coder` agent always opens its own browser; the `reviewer` agent gets a completely separate one.

**Requires:** Node.js, `npx`, and Chrome (stable) installed on the gateway host.

---

## Quick start

```sh
# Take an accessibility snapshot of the current page (start here)
/tools/bin/chrome take_snapshot

# Navigate to a URL
/tools/bin/chrome navigate_page --url https://example.com

# Take a screenshot (saved to /workspace/media/inbound/)
/tools/bin/chrome take_screenshot

# Click a button (uid from take_snapshot)
/tools/bin/chrome click --uid button-42

# Fill a form field
/tools/bin/chrome fill --uid input-7 --value hello@example.com

# Evaluate JavaScript
/tools/bin/chrome evaluate_script --function '() => document.title'

# List open tabs
/tools/bin/chrome list_pages

# List all available tools
/tools/bin/chrome --list-tools
```

---

## Calling conventions

**Flag-style** (simple values):
```sh
chrome navigate_page --url https://example.com
chrome click --uid button-42 --dblClick true
chrome resize_page --width 1920 --height 1080
```

**JSON params** (structured / nested data):
```sh
chrome fill_form '{"elements":[{"uid":"u1","value":"alice"},{"uid":"u2","value":"pass"}]}'
chrome evaluate_script '{"function":"() => document.querySelectorAll(\"a\").length"}'
```

Both forms produce the same underlying MCP call.

---

## Available tools

Run `chrome --list-tools` to see the live list from the running MCP server.

### Input automation
| Tool | Description |
|---|---|
| `click` | Click an element (uid from snapshot) |
| `drag` | Drag one element onto another |
| `fill` | Type into an input or select an option |
| `fill_form` | Fill multiple form fields at once |
| `handle_dialog` | Accept or dismiss a browser dialog |
| `hover` | Hover over an element |
| `press_key` | Press a key or key combination |
| `type_text` | Type text into the currently focused input |
| `upload_file` | Upload a file through a file input element |

### Navigation
| Tool | Description |
|---|---|
| `navigate_page` | Go to a URL, or back/forward/reload |
| `new_page` | Open a new tab |
| `list_pages` | List all open tabs |
| `select_page` | Switch to a different tab |
| `close_page` | Close a tab |
| `wait_for` | Wait until text appears on the page |

### Debugging
| Tool | Description |
|---|---|
| `take_snapshot` | Take an accessibility tree snapshot (use this first — much cheaper than screenshot) |
| `take_screenshot` | Take a screenshot (saved to `/workspace/media/inbound/`) |
| `evaluate_script` | Evaluate a JavaScript function in the page |
| `list_console_messages` | List browser console messages |
| `get_console_message` | Get a specific console message by ID |
| `take_snapshot` | Full DOM accessibility tree |
| `lighthouse_audit` | Lighthouse accessibility/SEO/best-practices audit |

### Network
| Tool | Description |
|---|---|
| `list_network_requests` | List network requests since last navigation |
| `get_network_request` | Get details of a specific request |

### Performance
| Tool | Description |
|---|---|
| `performance_start_trace` | Start a performance trace |
| `performance_stop_trace` | Stop trace and get results |
| `performance_analyze_insight` | Analyze a specific performance insight |
| `take_memory_snapshot` | Take a memory heap snapshot |

### Emulation
| Tool | Description |
|---|---|
| `emulate` | Emulate dark mode, network conditions, geolocation, user agent |
| `resize_page` | Resize the browser viewport |

> In `--slim` mode only `navigate`, `evaluate`, and `screenshot` are available.

---

## Screenshots

Screenshots are automatically saved to `/workspace/media/inbound/` with a timestamped filename. The path is injected into the `take_screenshot` call automatically — you don't need to specify `--filePath`.

```sh
chrome take_screenshot
# → Screenshot saved to: /media/inbound/screenshot-2026-03-17_22-14-00-000.png
```

The file is accessible inside the agent's sandbox at that path.

---

## Browser process lifecycle

- **Lazy start**: the browser only starts on the first tool call. No Chrome is launched just because the tool is configured.
- **Persistent per agent**: one process per agent, reused across all calls.
- **Idle timeout**: the process is killed automatically after `idleTimeoutMinutes` of inactivity (default: 30). The next call respawns it.
- **Crash recovery**: if Chrome crashes mid-call, the call returns an error and the process is cleaned up. The **next call** starts a fresh browser automatically — no manual restart needed.
- **Profile persistence**: the Chrome profile (`~/.beige/browser-profiles/<agentName>/`) is never deleted — logins and storage survive browser restarts.

---

## Configuration

```json5
tools: {
  chrome: {
    path: "~/.beige/toolkits/beige-toolkit/tools/chrome",
    target: "gateway",
    config: {
      // Launch in slim mode (only navigate/evaluate/screenshot). Default: false.
      slim: false,

      // Run Chrome headlessly. Default: false.
      headless: false,

      // Chrome channel: "stable" | "beta" | "dev" | "canary". Default: "stable".
      channel: "stable",

      // Viewport: "WxH". Default: unset.
      viewport: "1280x720",

      // Kill browser after N minutes idle. Default: 30.
      idleTimeoutMinutes: 30,

      // chrome-devtools-mcp npm version. Default: "latest".
      version: "latest",

      // Only these MCP tool names are callable (omit = allow all).
      allowTools: ["take_snapshot", "navigate_page", "take_screenshot"],

      // These MCP tool names are always blocked (deny beats allow).
      denyTools: ["evaluate_script"],

      // Timeout per MCP call in seconds. Default: 60.
      timeout: 60,

      // Opt out of Google usage statistics. Default: true.
      noUsageStatistics: true,

      // Proxy server. Optional.
      proxyServer: "http://proxy:8080",

      // Accept insecure TLS certs. Default: false.
      acceptInsecureCerts: false,
    },
  },
},
```

### Config examples

**Read-only browser agent** (can inspect but not interact):
```json5
config: {
  allowTools: ["take_snapshot", "take_screenshot", "list_pages",
               "list_console_messages", "list_network_requests"],
}
```

**Slim headless agent** (minimal token usage, no visible window):
```json5
config: {
  slim: true,
  headless: true,
}
```

**No JavaScript evaluation** (automation without script injection):
```json5
config: {
  denyTools: ["evaluate_script"],
}
```

---

## Security model

| Concern | How it is handled |
|---|---|
| **Per-agent isolation** | Each agent has its own Chrome profile directory. No cookie or session sharing between agents. |
| **Tool allowlist/denylist** | `allowTools` / `denyTools` restrict which MCP tools can be called. Deny beats allow. |
| **No default denylist** | Unlike the `slack` tool, all tools are permitted by default — browser access is already gated by the agent having `chrome` in its `tools` list. |
| **Profile never auto-deleted** | The profile directory is preserved across restarts. Delete `~/.beige/browser-profiles/<agentName>/` manually to reset. |
| **Usage statistics** | `noUsageStatistics: true` by default — Google telemetry is disabled for all agents. |

---

## Error reference

| Error | Cause |
|---|---|
| `agent identity unknown` | `BEIGE_AGENT_NAME` not set — requires beige ≥ 0.1.3 |
| `failed to start chrome-devtools-mcp` | `npx` not found, or Chrome not installed |
| `process exited unexpectedly` | Chrome crashed mid-call — next call respawns |
| `Permission denied: tool 'X' is blocked by denyTools` | Tool is in the denylist |
| `Permission denied: tool 'X' is not in allowTools` | allowTools is set and tool not listed |
| `MCP request timed out` | Tool call exceeded `timeout` seconds |
