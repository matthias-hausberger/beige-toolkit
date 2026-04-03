# Notion Plugin

A file-like abstraction for interacting with Notion pages and databases in the Beige Toolkit.

## Features

- **File-like operations**: Read, write, append, and patch Notion pages as if they were local files
- **Virtual filesystem**: Treat Notion as a filesystem with paths like `/notion/tasks/Task-1.md`
- **Markdown I/O**: Seamless Markdown support using Notion's Markdown endpoints
- **Database operations**: Query databases with filters and sorts
- **Search**: Full-text search across pages and databases
- **Comments**: List and add comments to pages
- **Rate limiting**: Built-in rate limiting and retry logic

## Installation

1. Create a Notion integration at https://notion.so/my-integrations
2. Copy the API key (starts with `ntn_` or `secret_`)
3. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)
4. Configure the plugin with your API key

## Configuration

```json
{
  "apiKey": "your_notion_api_key_here",
  "rateLimit": 3,
  "workspaceRootId": "optional_root_page_id"
}
```

### Configuration Options

- `apiKey` (required): Notion API token
- `rateLimit` (optional): Requests per second limit (default: 3)
- `workspaceRootId` (optional): Notion workspace root page ID for path resolution

## Usage

### Basic File Operations

#### Read a page as Markdown
```bash
notion read /notion/notes/Journal.md
```

#### Write content to a page
```bash
notion write /notion/notes/Test.md "# Hello World"
```

Or using the `--content` flag:
```bash
notion write /notion/notes/Test.md --content "# Hello World"
```

#### Append content to a page
```bash
notion append /notion/notes/Journal.md "\n## New Entry\n\nContent here"
```

#### Patch content in a page
```bash
notion patch /notion/notes/Journal.md "\n- Updated item"
```

### Listing and Searching

#### List child pages/databases
```bash
notion list
notion list /notion/tasks/
```

#### Search for pages and databases
```bash
notion search "project planning"
notion search "meeting notes" --type page
```

### Database Operations

#### Get database schema
```bash
notion databases get abc123def456
```

#### Query a database
```bash
notion databases query abc123def456
```

With filters:
```bash
notion databases query abc123def456 --filter '{"property":"Status","select":{"equals":"Active"}}'
```

With sorts:
```bash
notion databases query abc123def456 --sorts '[{"property":"Date","direction":"descending"}]'
```

### Comment Operations

#### List comments on a page
```bash
notion comments list abc123def456
```

#### Add a comment to a page
```bash
notion comments add abc123def456 --body "Please review this"
```

## Path Mapping

Paths use a virtual filesystem rooted at `/notion/`:

```
/notion/                 → Workspace root
/notion/tasks/           → Database or parent page
/notion/tasks/Task-1.md  → Specific page
/notion/notes/Journal/Subsection.md → Nested pages
```

## Examples

### Create a daily journal entry
```bash
notion append /notion/notes/Journal.md "\n## $(date +%Y-%m-%d)\n\nToday I worked on..."
```

### Search for project pages
```bash
notion search "project" --type page
```

### Query active tasks
```bash
notion databases query task_db_id --filter '{"property":"Status","select":{"equals":"Active"}}'
```

### Add a comment to a task page
```bash
notion comments add task_page_id --body "This is blocking progress on the main feature"
```

## Architecture

The plugin consists of three main components:

1. **Client** (`client.ts`): Handles Notion API communication with rate limiting and retry logic
2. **Filesystem** (`filesystem.ts`): Provides a file-like abstraction with path resolution
3. **Commands** (`commands.ts`): Parses and executes user commands

## Rate Limiting

The plugin respects Notion's rate limits (~3 requests/second by default). When rate limited, it automatically retries after the `Retry-After` delay specified by Notion.

## Error Handling

The plugin provides clear error messages for common issues:

- Authentication failures (invalid API key)
- Page not found (invalid path)
- Rate limiting (too many requests)
- Invalid filters/sorts (malformed JSON)

## Limitations

- Page creation is only supported within databases, not at workspace root
- The `patch` command currently appends content (a more sophisticated diff/merge could be added)
- Webhook support is not included (would require additional infrastructure)

## Future Enhancements

- Two-way sync (Notion ↔ local workspace)
- Conflict resolution strategies
- Obsidian vault migration tools
- Real-time webhook support
- Advanced database query builder
- Block-level operations (create specific block types)

## References

- [Notion API Docs](https://developers.notion.com/)
- [Markdown Endpoints](https://developers.notion.com/reference/patch-page-markdown)
- [Notion SDK](https://github.com/makenotion/notion-sdk-js)

## See Also

- [GitHub Issue #59](https://github.com/matthias-hausberger/beige-toolkit/issues/59) - Original issue and requirements
- [Notion Integration Research](https://github.com/beige-agent/beige-toolkit/blob/main/knowledge/notion-integration-research.md) - Research and design decisions
