# Navigation & Page Management

## Navigating to URLs

```sh
chrome navigate_page --url https://example.com
```

Navigate supports special actions:
```sh
chrome navigate_page --url back      # Go back
chrome navigate_page --url forward   # Go forward
chrome navigate_page --url reload    # Reload current page
```

## Managing Tabs

```sh
# Open a new tab
chrome new_page --url https://example.com

# List all open tabs
chrome list_pages

# Switch to a specific tab (use page ID from list_pages)
chrome select_page --pageId <id>

# Close a tab
chrome close_page --pageId <id>
```

## Waiting for Content

After navigation, you may need to wait for dynamic content:

```sh
# Wait until specific text appears on the page
chrome wait_for --text "Dashboard loaded"
```

## Viewport Control

```sh
# Resize the browser viewport
chrome resize_page --width 1920 --height 1080
```

## Emulation

```sh
# Emulate dark mode
chrome emulate --darkMode true

# Emulate a slow network
chrome emulate --networkCondition "3G"

# Emulate a geolocation
chrome emulate --latitude 37.7749 --longitude -122.4194

# Emulate a user agent
chrome emulate --userAgent "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
```

## Typical Navigation Workflow

1. Navigate to the page
2. Wait for content if needed
3. Take a snapshot to see what's on the page
4. Interact with elements using uids from the snapshot

```sh
chrome navigate_page --url https://app.example.com/dashboard
chrome wait_for --text "Welcome"
chrome take_snapshot
# Now use uids from the snapshot to interact
chrome click --uid nav-settings-42
```
