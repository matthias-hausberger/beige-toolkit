# DOM Inspection & Interaction

## Inspecting the Page

### Accessibility Snapshot (Preferred)

Always start with `take_snapshot` — it's cheap and gives you element uids:

```sh
chrome take_snapshot
```

The snapshot returns an accessibility tree with uids for every interactive element. Use these uids for all interaction commands.

### Screenshots

Use screenshots only when you need visual confirmation:

```sh
chrome take_screenshot
# → Screenshot saved to: /workspace/media/inbound/screenshot-2026-03-17_22-14-00-000.png
```

### JavaScript Evaluation

For complex queries that the snapshot doesn't cover:

```sh
# Get the page title
chrome evaluate_script --function '() => document.title'

# Count all links
chrome evaluate_script --function '() => document.querySelectorAll("a").length'

# Extract text from a specific element
chrome evaluate_script --function '() => document.querySelector(".status").textContent'

# Return structured data
chrome evaluate_script '{"function":"() => { return { url: location.href, title: document.title } }"}'
```

## Clicking Elements

```sh
# Single click (most common)
chrome click --uid button-42

# Double click
chrome click --uid item-7 --dblClick true
```

## Filling Forms

### Single Field

```sh
# Type into an input
chrome fill --uid input-7 --value "hello@example.com"

# Select a dropdown option
chrome fill --uid select-3 --value "option-value"
```

### Multiple Fields at Once

```sh
chrome fill_form '{"elements":[
  {"uid":"username-1","value":"alice"},
  {"uid":"password-2","value":"secret123"},
  {"uid":"role-3","value":"admin"}
]}'
```

## Keyboard Input

```sh
# Type text into the currently focused element
chrome type_text --text "Hello, World!"

# Press a specific key
chrome press_key --key Enter
chrome press_key --key Tab
chrome press_key --key Escape

# Key combinations
chrome press_key --key "Control+a"
chrome press_key --key "Control+c"
```

## Other Interactions

```sh
# Hover over an element
chrome hover --uid menu-5

# Drag and drop
chrome drag --startUid item-1 --endUid dropzone-2

# Handle browser dialogs (alert, confirm, prompt)
chrome handle_dialog --accept true
chrome handle_dialog --accept false  # dismiss

# Upload a file
chrome upload_file --uid file-input-1 --filePath /workspace/document.pdf
```

## Console Messages

```sh
# List all console messages (errors, warnings, logs)
chrome list_console_messages

# Get a specific message by ID
chrome get_console_message --id msg-123
```

## Typical Form-Filling Workflow

1. Navigate to the form page
2. Snapshot to discover form field uids
3. Fill the fields
4. Click submit
5. Snapshot or screenshot to verify the result

```sh
chrome navigate_page --url https://app.example.com/signup
chrome take_snapshot
chrome fill_form '{"elements":[
  {"uid":"email-1","value":"user@example.com"},
  {"uid":"name-2","value":"Alice"}
]}'
chrome click --uid submit-3
chrome take_snapshot  # verify success
```
