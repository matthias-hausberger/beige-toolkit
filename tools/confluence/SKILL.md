# Confluence Tool — Usage Guide

Interact with Atlassian Confluence. All arguments are passed to `confluence-cli` on the gateway host. The tool enforces command-level and space-level permissions before executing.

## Calling Convention

```sh
/tools/bin/confluence <subcommand> [args...]
```

## Examples

### Reading Pages

```sh
# Read a page by ID (markdown is preferred for reading — keeps context low)
/tools/bin/confluence read 123456789 --format markdown

# Read in HTML format (only needed when preparing to update a page)
/tools/bin/confluence read 123456789 --format html

# Get page metadata
/tools/bin/confluence info 123456789
```

### Searching

```sh
# Search for pages
/tools/bin/confluence search "API documentation" --limit 5

# Search scoped to a space
/tools/bin/confluence search "API documentation" --space DOCS --limit 5

# Find page by exact title
/tools/bin/confluence find "Getting Started" --space DOCS
```

### Navigating Structure

```sh
# List all spaces
/tools/bin/confluence spaces

# List child pages
/tools/bin/confluence children 123456789

# Recursive children with tree format
/tools/bin/confluence children 123456789 --recursive --format tree
```

### Creating Pages

```sh
# Create a page
/tools/bin/confluence create "My New Page" SPACEKEY --content "**Hello** World!" --format markdown

# Create a child page
/tools/bin/confluence create-child "Sub Page" 123456789 --content "Content here"
```

---

## ⚠️ Updating Pages — CRITICAL: Preserve Format and Templates

**Never rewrite a Confluence page from scratch.** Confluence pages contain storage-format HTML with macros, templates, layouts, and metadata that will be lost if you write new content directly. Always follow this process:

### The Safe Update Process

**Step 1: Export the page as HTML**

```sh
# Export the current page content to an HTML file
/tools/bin/confluence export 123456789 --format html --dest /workspace/confluence/
```

This gives you the full storage-format HTML including all macros, layouts, templates, and structured content.

**Step 2: Patch the HTML file — do NOT rewrite it**

Read the exported HTML file and make **surgical edits only**. Change only the specific text, sections, or values that need updating. Leave all surrounding HTML structure, macro tags (`<ac:structured-macro>`), layout elements (`<ac:layout>`), and template markup intact.

```sh
# Read the exported file
# Then use patch/edit to modify only the parts that need changing
# NEVER replace the entire file content
```

**Step 3: Validate HTML integrity**

Before uploading, verify the HTML is well-formed. Check that:
- All tags are properly opened and closed
- Confluence macros (`<ac:...>`) are intact
- Layout sections are complete
- No template markup was accidentally removed or broken

**Step 4: Upload and publish**

```sh
# Update the page from the patched HTML file
/tools/bin/confluence update 123456789 --file /workspace/confluence/page.html --format html
```

### Why This Matters

Confluence storage format contains:
- **Macros** (`<ac:structured-macro>`) — table of contents, status labels, panels, code blocks, Jira links, etc.
- **Layouts** (`<ac:layout>`, `<ac:layout-section>`, `<ac:layout-cell>`) — multi-column layouts
- **Templates** — pre-built page structures with placeholder content
- **Rich metadata** — labels, properties, embedded content references

If you rewrite the page with plain text or markdown, **all of this is destroyed** and cannot be recovered. The page will lose its formatting, structure, and any embedded functionality.

### Example: Updating a Section in an Existing Page

```sh
# 1. Export current content
/tools/bin/confluence export 123456789 --format html --dest /workspace/confluence/

# 2. Read the HTML to understand the structure
#    (examine the file to find the section you need to change)

# 3. Patch ONLY the specific text/section that needs updating
#    Leave all HTML structure, macros, and layout tags untouched

# 4. Upload the patched file
/tools/bin/confluence update 123456789 --file /workspace/confluence/page.html --format html
```

### When It's Safe to Use Other Formats

- **Creating brand new pages** — markdown or plain text is fine since there's no existing structure to preserve
- **Reading pages** — use `--format markdown` (preferred, keeps context low). Only use `--format html` when you need the exact structure for an update.
- **Updating pages you just created** with simple content and no macros — but prefer the HTML workflow to be safe

---

### Deleting & Moving

```sh
# Delete a page (--yes skips confirmation)
/tools/bin/confluence delete 123456789 --yes

# Move a page under a new parent
/tools/bin/confluence move 123456789 987654321
```

### Attachments

```sh
# List attachments
/tools/bin/confluence attachments 123456789

# Upload an attachment
/tools/bin/confluence attachment-upload 123456789 --file /workspace/diagram.png

# Download attachments
/tools/bin/confluence attachments 123456789 --download --dest /workspace/downloads/
```

### Comments

```sh
# List comments
/tools/bin/confluence comments 123456789

# Add a comment
/tools/bin/confluence comment 123456789 --content "Looks good!"

# Reply to a comment
/tools/bin/confluence comment 123456789 --content "Agreed" --parent 111222333
```

### Content Properties

```sh
# List properties
/tools/bin/confluence property-list 123456789

# Get a property
/tools/bin/confluence property-get 123456789 my-key

# Set a property
/tools/bin/confluence property-set 123456789 my-key --value '{"status":"approved"}'
```

### Exporting

```sh
# Export a page to HTML (preserves full structure)
/tools/bin/confluence export 123456789 --format html --dest /workspace/exports/

# Export a page to markdown (for reading only — not for round-tripping back)
/tools/bin/confluence export 123456789 --format markdown --dest /workspace/exports/
```

### Profiles

```sh
# List profiles
/tools/bin/confluence profile list

# Switch profile
/tools/bin/confluence profile use staging
```

## Understanding Permissions

There are two independent layers:

1. **Command-level** — which subcommands you can run at all
2. **Space-level** — which Confluence spaces you can read from / write to

If a command is denied, you'll see errors like:

```
Permission denied: command 'delete' is blocked by denyCommands
Permission denied: space 'SECRET' is not in allowReadSpaces
```

### Profile Injection

If a default profile is configured, `--profile` is automatically prepended to your calls unless you specify one explicitly.

## Tips

- **Always use the HTML export → patch → upload workflow when updating existing pages.**
- Use `--format markdown` when reading pages for information (preferred — keeps context low).
- Only use `--format html` when you need the exact page structure for an update.
- Always specify `--limit` on search to avoid huge responses.
- Use `--space` on search when you know which space to target.
- The `--yes` flag skips confirmation prompts on destructive operations.
- Run `confluence <subcommand> --help` for full flag reference.
- The tool is stateless — each invocation spawns a fresh process.
