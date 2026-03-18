# confluence

Interact with Atlassian Confluence via the [`confluence-cli`](https://github.com/pchuri/confluence-cli) binary installed on the gateway host. Agents pass `confluence` arguments directly; the tool enforces two independent, optional permission layers before executing anything.

**Requires:** `confluence-cli` installed and authenticated on the gateway host.

**Authentication:** The tool assumes the host is already logged in. Run `confluence init` on the gateway once to set up credentials. See [confluence-cli setup](https://github.com/pchuri/confluence-cli#configuration) for details.

---

## Quick start

```sh
# Read a page by ID
/tools/bin/confluence read 123456789

# Read a page in markdown format
/tools/bin/confluence read 123456789 --format markdown

# Search for pages (scoped to a space)
/tools/bin/confluence search "API documentation" --space DOCS --limit 5

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

All `confluence` subcommands are available subject to configured restrictions. By default, **all commands are permitted** — no denylist and no space restrictions are applied.

### Read / search

```sh
confluence read <pageId|url> [--format text|html|markdown]
confluence info <pageId|url>
confluence search <query> [--space <key>] [--limit <n>]
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

There are two independent, optional permission layers. Either, both, or neither can be configured. They compose: a call must pass **both** layers to proceed.

```
Agent call
    │
    ▼
┌─────────────────────────┐
│  Layer 1: command-level │  denyCommands / allowCommands
│  (subcommand name only) │  → fast, no API calls
└────────────┬────────────┘
             │ allowed
             ▼
┌─────────────────────────┐
│  Layer 2: space-level   │  allowReadSpaces / allowWriteSpaces
│  (which space/page)     │  → Tier 1 free, Tier 2 one info call
└────────────┬────────────┘
             │ allowed
             ▼
         Execute
```

---

### Layer 1 — command-level

Controls which subcommands the agent may run at all, without any awareness of which page or space is targeted.

| Args | Command path |
|---|---|
| `read 123456789 --format markdown` | `read` |
| `search "term" --limit 5` | `search` |
| `create "Title" SPACE` | `create` |
| `create-child "Title" 123` | `create-child` |
| `profile list` | `profile list` |
| `profile use staging` | `profile use` |
| `--profile prod read 123` | `read` (global `--profile` flag is skipped) |

**Prefix matching:** `"create"` in a deny list blocks both `create` and `create-child`. `"profile"` blocks all profile subcommands.

**Precedence:** deny beats allow:
1. `denyCommands` — if any entry matches → rejected immediately
2. `allowCommands` — if set and no entry matches → rejected
3. Otherwise → permitted

---

### Layer 2 — space-level

Controls which Confluence **spaces** the agent may read from and write to. This layer is **completely skipped** when neither `allowReadSpaces` nor `allowWriteSpaces` is configured.

#### Command classification

| Kind | Commands |
|---|---|
| **READ** | `read`, `info`, `children`, `attachments`, `comments`, `property-list`, `property-get`, `export`, `edit`, `find`, `search` |
| **WRITE** | `create`, `create-child`, `update`, `delete`, `move`, `copy-tree`, `attachment-upload`, `attachment-delete`, `comment`, `property-set`, `property-delete` |
| **AGNOSTIC** (always pass) | `spaces`, `stats`, `profile`, `init`, `comment-delete` |

READ commands are checked against `allowReadSpaces`; WRITE commands against `allowWriteSpaces`. The two lists are fully independent — configuring one does not restrict the other.

#### Space resolution

The tool needs to know the target space before it can enforce the policy. Two strategies are used:

**Tier 1 — static (free, no API call):**
- `create` — the space key is the second positional argument (`confluence create "Title" SPACEKEY`)
- `find --space` and `search --space` — the `--space` flag value is used directly
- URL arguments — the space key is parsed from the URL path (`/wiki/spaces/SPACEKEY/`)

**Tier 2 — dynamic (one `confluence info` lookup):**
- Any command whose target is a numeric page ID (e.g. `read 123456789`, `update 123456789`)
- The tool calls `confluence info <pageId>` internally, parses the `Space:` line from the output, and caches the result in-process for the lifetime of the gateway session
- The same `--profile` configured for the tool is forwarded to these lookups

For `copy-tree` and `move`, which take two page IDs (source and target parent), **both** are resolved and checked independently.

**Fail-open:** if a space key cannot be determined (e.g. the `info` call returns no `Space:` line, or the command has no extractable target), the call is **allowed through**. This avoids false blocks on edge cases. Combine with `denyCommands` if you need hard guarantees on specific commands.

#### ⚠️ CQL disclaimer

The `search` command accepts a free-text query that may contain **CQL expressions**, for example:

```sh
confluence search "space IN (TEAM, SECRET) AND label = docs"
```

**This tool only inspects the `--space` flag.** CQL embedded in the query string is NOT parsed or enforced. If strict space isolation for search is required:

1. Set `requireSpaceOnSearch: true` — rejects any search call that does not include `--space`
2. Agents must then pass `--space TEAM` explicitly
3. Understand that a determined agent could still embed CQL in the query string — if you cannot trust the agent at that level, combine with network-level controls or use the Confluence API's built-in read-only mode (`confluence init --read-only`)

#### ⚠️ comment-delete disclaimer

`comment-delete <commentId>` takes a comment ID, not a page ID or URL. There is no way to look up a comment's parent page or space from a comment ID using confluence-cli alone, so **space enforcement is not applied to `comment-delete`**. It is classified as agnostic and always passes the space layer. Use `denyCommands: ["comment-delete"]` to block it entirely if needed.

---

## Configuration

```json5
tools: {
  confluence: {
    path: "~/.beige/toolkits/beige-toolkit/tools/confluence",
    target: "gateway",
    config: {
      // Layer 1: command-level (omit to allow all commands)
      allowCommands: ["read", "search", "info", "spaces", "find", "children"],
      denyCommands: ["create", "update", "delete", "move"],

      // Layer 2: space-level (omit either to allow all spaces for that operation)
      allowReadSpaces: ["DOCS", "TEAM"],
      allowWriteSpaces: ["DRAFTS"],

      // Reject search without --space (note: CQL in query string is not enforced)
      requireSpaceOnSearch: true,

      // Timeout per confluence call in seconds (default: 30)
      timeout: 30,

      // Default profile — prepended as --profile when not specified by agent
      profile: "production",
    },
  },
},
```

---

## Config examples

**Read-only agent, all spaces:**
```json5
config: {
  denyCommands: ["create", "create-child", "update", "delete", "move", "copy-tree",
                 "attachment-upload", "attachment-delete", "comment", "comment-delete",
                 "property-set", "property-delete"],
}
```

**Read-only agent, scoped to DOCS and TEAM spaces:**
```json5
config: {
  denyCommands: ["create", "create-child", "update", "delete", "move", "copy-tree",
                 "attachment-upload", "attachment-delete", "comment", "comment-delete",
                 "property-set", "property-delete"],
  allowReadSpaces: ["DOCS", "TEAM"],
  requireSpaceOnSearch: true,
}
```

**Documentation bot (reads anywhere, writes only to DRAFTS):**
```json5
config: {
  allowWriteSpaces: ["DRAFTS"],
}
```

**Strictly scoped documentation bot (reads from DOCS/TEAM, writes to DRAFTS only):**
```json5
config: {
  allowReadSpaces: ["DOCS", "TEAM"],
  allowWriteSpaces: ["DRAFTS"],
  requireSpaceOnSearch: true,
}
```

**Write-safe agent (all reads allowed; only non-destructive writes):**
```json5
config: {
  denyCommands: ["delete", "move", "attachment-delete", "comment-delete", "property-delete"],
}
```

**Full access, always use the production profile:**
```json5
config: {
  profile: "production",
}
```

---

## Profile injection

If `config.profile` is set, the tool prepends `--profile <value>` to every call when `--profile` is not already in the agent's args. The agent-provided value takes precedence.

This also applies to the internal `confluence info` lookups used for Tier 2 space resolution, so they always use the correct authentication context.

```
confluence --profile production read 123456789
confluence --profile production info 123456789   ← internal lookup, same profile
```

---

## Error reference

| Error | Cause |
|---|---|
| `confluence not found on PATH` | Binary not installed or not on gateway's PATH |
| `Permission denied: command 'X' is blocked by denyCommands` | Command matched a deny entry |
| `Permission denied: command 'X' is not in allowCommands` | allowCommands is set and command not listed |
| `Permission denied: space 'X' is not in allowReadSpaces` | Page/space not in the read allowlist |
| `Permission denied: space 'X' is not in allowWriteSpaces` | Page/space not in the write allowlist |
| `Permission denied: search without --space is not permitted` | requireSpaceOnSearch is enabled and --space flag is missing |
| *(non-zero exit, error message in output)* | confluence-cli itself returned an error |
| `(no output)` | confluence-cli ran successfully but produced no output |
