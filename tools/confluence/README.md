# confluence

Interact with Atlassian Confluence via the [`confluence-cli`](https://github.com/pchuri/confluence-cli) binary installed on the gateway host. Agents pass `confluence` arguments directly; the tool enforces an optional permission layer before executing anything.

**Requires:** `confluence-cli` installed and authenticated on the gateway host.

**Authentication:** The tool assumes the host is already logged in. Run `confluence init` on the gateway once to set up credentials. See [confluence-cli setup](https://github.com/pchuri/confluence-cli#configuration) for details.

---

## Quick start

```sh
# Read a page by ID
/tools/bin/confluence read 123456789

# Read a page in markdown format
/tools/bin/confluence read 123456789 --format markdown

# Search for pages
/tools/bin/confluence search "API documentation" --limit 5

# List all spaces
/tools/bin/confluence spaces

# List child pages
/tools/bin/confluence children 123456789 --recursive --format tree

# Create a page
/tools/bin/confluence create "My New Page" SPACEKEY --content "**Hello** World!" --format markdown

# Update a page
/tools/bin/confluence update 123456789 --content "Updated content"

# Delete a page
/tools/bin/confluence delete 123456789 --yes
```

---

## Available commands

All `confluence` subcommands are available subject to the configured allow/deny lists. By default, **all commands are permitted** — no default denylist is applied (unlike the slack tool, confluence-cli authentication happens once at setup time and is not something agents can accidentally invoke).

### Read / search

```sh
confluence read <pageId|url> [--format text|html|markdown]
confluence info <pageId|url>
confluence search <query> [--limit <n>]
confluence spaces
confluence find <title> [--space <key>]
confluence children <pageId> [--recursive] [--max-depth <n>] [--format list|tree|json] [--show-id] [--show-url]
```

### Create / update / delete

```sh
confluence create <title> <spaceKey> [--content <text>] [--file <path>] [--format markdown|html|storage]
confluence create-child <title> <parentId> [--content <text>] [--file <path>] [--format markdown|html|storage]
confluence copy-tree <sourceId> <targetParentId> [newTitle] [--max-depth <n>] [--exclude <patterns>] [--dry-run] [--copy-suffix <text>]
confluence update <pageId> [--title <t>] [--content <text>] [--file <path>] [--format markdown|html|storage]
confluence move <pageId|url> <newParentId|url> [--title <t>]
confluence delete <pageId|url> [--yes]
confluence edit <pageId> [--output <file>]
```

### Attachments

```sh
confluence attachments <pageId|url> [--limit <n>] [--pattern <glob>] [--download] [--dest <dir>]
confluence attachment-upload <pageId|url> --file <path> [--comment <text>] [--replace] [--minor-edit]
confluence attachment-delete <pageId|url> <attachmentId> [--yes]
```

### Comments

```sh
confluence comments <pageId|url> [--format text|markdown|json] [--limit <n>] [--location inline|footer|resolved]
confluence comment <pageId|url> --content <text> [--parent <commentId>] [--location inline|footer]
confluence comment-delete <commentId> [--yes]
```

### Content properties

```sh
confluence property-list <pageId|url> [--format text|json]
confluence property-get <pageId|url> <key> [--format text|json]
confluence property-set <pageId|url> <key> --value <json>
confluence property-delete <pageId|url> <key> [--yes]
```

### Export / edit workflow

```sh
confluence export <pageId|url> [--format markdown|html|text] [--dest <dir>] [--file <filename>] [--skip-attachments]
confluence edit <pageId> [--output <file>]
```

### Profiles

```sh
confluence profile list
confluence profile use <name>
confluence profile add <name> [--domain <d>] [--api-path <p>] [--auth-type basic|bearer] [--email <e>] [--token <t>] [--read-only]
confluence profile remove <name>

confluence stats
```

Run `confluence <subcommand> --help` for full flag reference.

---

## Permission model

Access is controlled at the **command path** level. A command path is the leading 1–2 subcommand tokens before any flags. The global `--profile` flag (when it appears before the subcommand) is automatically skipped during extraction.

| Args | Command path |
|---|---|
| `read 123456789 --format markdown` | `read` |
| `search "term" --limit 5` | `search` |
| `create "Title" SPACE` | `create` |
| `create-child "Title" 123` | `create-child` |
| `profile list` | `profile list` |
| `profile use staging` | `profile use` |
| `--profile prod read 123` | `read` |

**Matching is by prefix:** `"create"` in a deny list blocks both `create` and `create-child`. `"profile"` blocks all profile subcommands. `"profile list"` blocks only list.

**Precedence:** deny beats allow. Checked in order:
1. `denyCommands` — if any entry matches → rejected immediately
2. `allowCommands` — if set and no entry matches → rejected
3. Otherwise → permitted

### Default behaviour

When **no config is provided**, the default denylist is **empty** — all commands are permitted. This is intentional: confluence-cli authentication is set up once by a human (`confluence init`) and agents cannot accidentally mutate credentials.

If you want to restrict agents, configure `denyCommands` or `allowCommands` explicitly.

---

## Configuration

```json5
tools: {
  confluence: {
    path: "~/.beige/toolkits/beige-toolkit/tools/confluence",
    target: "gateway",
    config: {
      // Allow only specific command paths (omit to allow all)
      allowCommands: ["read", "search", "info", "spaces", "find", "children"],

      // Always block these command paths (deny beats allow)
      denyCommands: ["create", "update", "delete", "move"],

      // Timeout per confluence call in seconds (default: 30)
      timeout: 30,

      // Default profile — prepended as --profile when not specified by agent
      profile: "production",
    },
  },
},
```

### Config examples

**Read-only agent** (can read and search, nothing else):
```json5
config: {
  allowCommands: ["read", "search", "info", "spaces", "find", "children", "attachments", "comments", "property-list", "property-get", "export"],
}
```

**Write-safe agent** (all reads + comments allowed; destructive ops blocked):
```json5
config: {
  denyCommands: ["delete", "move", "attachment-delete", "comment-delete", "property-delete"],
}
```

**Documentation bot** (can create and update pages, read-only otherwise):
```json5
config: {
  allowCommands: ["read", "info", "search", "spaces", "find", "children", "create", "create-child", "update"],
}
```

**Full access, scoped to a specific profile** (all commands, always use "production"):
```json5
config: {
  profile: "production",
}
```

**Locked-down CI agent** (can only export pages for archiving):
```json5
config: {
  allowCommands: ["export", "attachments"],
}
```

---

## Profile injection

If `config.profile` is set, the tool automatically prepends `--profile <value>` to every call when `--profile` is not already in the agent's args. The agent-provided value takes precedence.

```json5
config: {
  profile: "production",
}
```

The injected flag is placed before the subcommand, which is what confluence-cli expects:

```
confluence --profile production read 123456789
```

---

## Error reference

| Error | Cause |
|---|---|
| `confluence not found on PATH` | Binary not installed or not on gateway's PATH |
| `Permission denied: command 'X' is blocked by denyCommands` | Command matched a deny entry |
| `Permission denied: command 'X' is not in allowCommands` | allowCommands is set and command not listed |
| *(non-zero exit, error message in output)* | confluence-cli itself returned an error — check output |
| `(no output)` | confluence-cli ran successfully but produced no output |
