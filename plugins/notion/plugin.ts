/**
 * Notion plugin for Beige Toolkit
 * Provides file-like abstraction for interacting with Notion pages and databases
 */

import { Tool } from '../_shared/types.js';
import { NotionClient, RateLimitError } from './client.js';
import { NotionFileSystem } from './filesystem.js';
import { handleCommand } from './commands.js';

export interface NotionConfig {
  apiKey: string;
  rateLimit?: number;
  workspaceRootId?: string;
}

const tool: Tool = {
  name: 'notion',
  description: `Interact with Notion via the Notion API. Provides file-like operations for reading, writing, and managing Notion pages and databases.

## Usage

### Basic File Operations
- \`notion read <path>\` - Read a Notion page as Markdown
  - Example: \`notion read /notion/notes/Journal.md\`
  - Example: \`notion read /notion/tasks/Task-1.md\`

- \`notion write <path> <content>\` - Write/replace content in a Notion page
  - Example: \`notion write /notion/notes/Test.md "# Hello World"\`
  - Example: \`notion write /notion/notes/Test.md --content "# Hello World"\`

- \`notion append <path> <content>\` - Append content to a Notion page
  - Example: \`notion append /notion/notes/Journal.md "\\n## New Entry\\n\\nContent here"\`

- \`notion patch <path> <changes>\` - Patch/merge content in a Notion page
  - Example: \`notion patch /notion/notes/Journal.md "\\n- Updated item"\`

### Listing and Searching
- \`notion list [path]\` - List child pages/databases under a parent
  - Example: \`notion list\` (lists /notion/)
  - Example: \`notion list /notion/tasks/\`

- \`notion search <query> [--type <page|database>]\` - Search for pages and databases
  - Example: \`notion search "project planning"\`
  - Example: \`notion search "meeting notes" --type page\`

### Database Operations
- \`notion databases get <id>\` - Get database schema
  - Example: \`notion databases get abc123def456\`

- \`notion databases query <id> [--filter <json>] [--sorts <json>]\` - Query a database
  - Example: \`notion databases query abc123def456\`
  - Example: \`notion databases query abc123def456 --filter '{"property":"Status","select":{"equals":"Active"}}'\`

### Comment Operations
- \`notion comments list <page_id>\` - List comments on a page
  - Example: \`notion comments list abc123def456\`

- \`notion comments add <page_id> --body <text>\` - Add a comment to a page
  - Example: \`notion comments add abc123def456 --body "Please review this"\`

## Path Mapping

Paths use a virtual filesystem rooted at \`/notion/\`:
- \`/notion/\` - Workspace root
- \`/notion/tasks/\` - Database or parent page
- \`/notion/tasks/Task-1.md\` - Specific page
- \`/notion/notes/Journal/Subsection.md\` - Nested pages

## Setup

1. Create a Notion integration at https://notion.so/my-integrations
2. Copy the API key (starts with \`ntn_\` or \`secret_\`)
3. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)
4. Configure the plugin with your API key:
   - Set \`apiKey\` in the plugin config
   - Optionally set \`workspaceRootId\` for path resolution
   - Optionally set \`rateLimit\` (default: 3 requests/second)

## Notes

- All file operations use Notion's Markdown endpoints for seamless Markdown I/O
- The plugin respects Notion's rate limits (~3 requests/second by default)
- Supports automatic retry with exponential backoff for rate limit errors
- Pages are cached for performance; use the same paths consistently
- Database operations require proper property names and types`,
  target: 'node',
  config: {
    required: {
      apiKey: {
        description: 'Notion API token (create at https://notion.so/my-integrations)',
        type: 'string',
        env: 'NOTION_API_KEY',
      },
    },
    optional: {
      rateLimit: {
        description: 'Requests per second limit (default: 3)',
        type: 'number',
        default: 3,
      },
      workspaceRootId: {
        description: 'Notion workspace root page ID (optional, for path resolution)',
        type: 'string',
      },
    },
  },
  handler: async (input, config, sessionContext) => {
    try {
      // Validate config
      if (!config.apiKey) {
        throw new Error('Missing required config: apiKey. Please set NOTION_API_KEY environment variable or configure apiKey in plugin config.');
      }

      // Parse config values
      const apiKey = config.apiKey as string;
      const rateLimit = (config.rateLimit as number) || 3;
      const workspaceRootId = config.workspaceRootId as string | undefined;

      // Create client and filesystem
      const client = new NotionClient(apiKey, rateLimit);

      // Handle the command
      const result = await handleCommand(input, client, workspaceRootId);

      if (!result.success) {
        return {
          exitCode: 1,
          output: `Error: ${result.error}`,
        };
      }

      // Format output
      let output = '';

      if (result.data) {
        if (result.data.content !== undefined) {
          // Read operation - return content directly
          output = result.data.content;
        } else if (result.data.entries) {
          // List operation - format entries
          output = formatEntries(result.data.entries, result.data.path);
        } else if (result.data.results) {
          // Search or query operation - format results
          output = formatResults(result.data.results, result.data.query || result.data.databaseId);
        } else if (result.data.comments) {
          // Comment list operation - format comments
          output = formatComments(result.data.comments);
        } else if (result.data.database) {
          // Database get operation - format database schema
          output = formatDatabase(result.data.database);
        } else if (result.data.comment) {
          // Comment add operation
          output = result.data.message || 'Success';
        } else {
          // General success message
          output = result.data.message || 'Success';
        }
      }

      return {
        exitCode: 0,
        output,
      };
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          exitCode: 1,
          output: `Rate limited. Please retry after ${error.retryAfter} seconds.`,
        };
      }

      if (error instanceof Error) {
        return {
          exitCode: 1,
          output: `Error: ${error.message}`,
        };
      }

      return {
        exitCode: 1,
        output: 'Unknown error occurred',
      };
    }
  },
};

/**
 * Format file entries for list command
 */
function formatEntries(entries: any[], path: string): string {
  if (entries.length === 0) {
    return `No entries found at ${path}`;
  }

  const lines = [`Entries at ${path}:`, ''];

  for (const entry of entries) {
    const icon = entry.type === 'database' ? '📊' : '📄';
    lines.push(`${icon} ${entry.path} (${entry.id})`);
  }

  lines.push('');
  lines.push(`Total: ${entries.length} entries`);

  return lines.join('\n');
}

/**
 * Format search/query results
 */
function formatResults(results: any[], queryOrId: string): string {
  if (results.length === 0) {
    return `No results found for "${queryOrId}"`;
  }

  const lines = [`Results for "${queryOrId}":`, ''];

  for (const result of results) {
    const title = result.title || result.properties?.Name?.title?.[0]?.text?.content || 'Untitled';
    const icon = result.object === 'database' ? '📊' : '📄';
    lines.push(`${icon} ${title} (${result.id})`);

    if (result.url) {
      lines.push(`   URL: ${result.url}`);
    }
  }

  lines.push('');
  lines.push(`Total: ${results.length} results`);

  return lines.join('\n');
}

/**
 * Format comments
 */
function formatComments(comments: any[]): string {
  if (comments.length === 0) {
    return 'No comments found';
  }

  const lines = ['Comments:', ''];

  for (const comment of comments) {
    const text = comment.rich_text?.map((t: any) => t.text?.content).join('') || '';
    const createdAt = new Date(comment.created_time).toLocaleString();
    lines.push(`[${createdAt}] ${text}`);
    lines.push(`  ID: ${comment.id}`);
    lines.push('');
  }

  lines.push(`Total: ${comments.length} comments`);

  return lines.join('\n');
}

/**
 * Format database schema
 */
function formatDatabase(database: any): string {
  const lines = ['Database Schema:', ''];
  lines.push(`ID: ${database.id}`);
  lines.push(`Title: ${database.title?.[0]?.text?.content || 'Untitled'}`);

  if (database.properties) {
    lines.push('');
    lines.push('Properties:');
    for (const [name, prop] of Object.entries(database.properties)) {
      const type = (prop as any).type;
      lines.push(`  - ${name} (${type})`);
    }
  }

  return lines.join('\n');
}

export default tool;
