/**
 * Notion plugin command handlers
 */

import { NotionClient, NotionClientError, RateLimitError } from './client.js';
import { NotionFileSystem } from './filesystem.js';
import { DatabaseQueryOptions, PageReadState } from './types.js';

export interface CommandArgs {
  command: string;
  subcommand?: string;
  args: string[];
  options: Record<string, string>;
}

export interface CommandResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Session state for tracking page reads
 * This is stored in memory per session
 */
const sessionReadState = new Map<string, PageReadState>();

/**
 * Get or create session read state for a path
 */
function getOrCreateReadState(path: string, pageId: string, lastModifiedTime: string): PageReadState {
  const state: PageReadState = {
    path,
    pageId,
    lastModifiedTime,
  };
  sessionReadState.set(path, state);
  return state;
}

/**
 * Get read state for a path
 */
function getReadState(path: string): PageReadState | undefined {
  return sessionReadState.get(path);
}

/**
 * Update read state
 */
function updateReadState(path: string, state: PageReadState): void {
  sessionReadState.set(path, state);
}

/**
 * Clear read state for a path
 */
function clearReadState(path: string): void {
  sessionReadState.delete(path);
}

/**
 * Parse command line arguments
 */
export function parseCommand(input: string): CommandArgs {
  const tokens = input.trim().split(/\s+/);
  const command = tokens[0];
  const subcommand = tokens[1];
  const args: string[] = [];
  const options: Record<string, string> = {};

  let i = 2;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.startsWith('--')) {
      const optionName = token.slice(2);
      const optionValue = tokens[i + 1];

      if (optionValue && !optionValue.startsWith('--')) {
        options[optionName] = optionValue;
        i += 2;
      } else {
        options[optionName] = 'true';
        i += 1;
      }
    } else {
      args.push(token);
      i += 1;
    }
  }

  return { command, subcommand, args, options };
}

/**
 * Handle Notion commands
 */
export async function handleCommand(
  input: string,
  client: NotionClient,
  workspaceRootId?: string,
  notionWorkspacePath: string = 'notion/',
  downloadPageByDefault: boolean = true
): Promise<CommandResult> {
  try {
    const { command, subcommand, args, options } = parseCommand(input);

    if (command !== 'notion') {
      return { success: false, error: 'Invalid command. Expected "notion"' };
    }

    if (!subcommand) {
      return { success: false, error: 'Missing subcommand. Usage: notion <subcommand> [options]' };
    }

    const fs = new NotionFileSystem(client, workspaceRootId, notionWorkspacePath);

    switch (subcommand) {
      case 'read':
        return await handleRead(fs, args, options, downloadPageByDefault);
      case 'write':
        return await handleWrite(fs, args, options, client);
      case 'append':
        return await handleAppend(fs, args, options, client);
      case 'patch':
        return await handlePatch(fs, args, options);
      case 'list':
        return await handleList(fs, args, options);
      case 'search':
        return await handleSearch(fs, args, options);
      case 'databases':
        return await handleDatabases(client, args, options);
      case 'comments':
        return await handleComments(client, args, options);
      default:
        return {
          success: false,
          error: `Unknown subcommand: ${subcommand}. Valid subcommands: read, write, append, patch, list, search, databases, comments`,
        };
    }
  } catch (error) {
    if (error instanceof RateLimitError) {
      return {
        success: false,
        error: `Rate limited. Please retry after ${error.retryAfter} seconds.`,
      };
    }

    if (error instanceof NotionClientError) {
      return {
        success: false,
        error: `Notion API Error [${error.code}]: ${error.message}`,
      };
    }

    if (error instanceof Error) {
      return { success: false, error: error.message };
    }

    return { success: false, error: 'Unknown error occurred' };
  }
}

/**
 * Handle: notion read <path>
 */
async function handleRead(
  fs: NotionFileSystem,
  args: string[],
  options: Record<string, string>,
  downloadPageByDefault: boolean
): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing path. Usage: notion read <path> [--download]' };
  }

  const path = args[0];
  const download = options.download === 'true' || (downloadPageByDefault && options.download !== 'false');

  const result = await fs.readFile(path, download);

  // Store read state for validation on write/patch
  const pageId = await (fs as any).resolvePath(path);
  const state = getOrCreateReadState(path, pageId, result.lastModifiedTime);
  if (result.localPath) {
    state.localPath = result.localPath;
    updateReadState(path, state);
  }

  const responseData: any = {
    path,
    content: result.content,
    lastModifiedTime: result.lastModifiedTime,
  };

  if (result.localPath) {
    responseData.localPath = result.localPath;
  }

  if (result.wasOverridden) {
    responseData.wasOverridden = true;
  }

  return { success: true, data: responseData };
}

/**
 * Handle: notion write <path> <content>
 */
async function handleWrite(
  fs: NotionFileSystem,
  args: string[],
  options: Record<string, string>,
  client: NotionClient
): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing path. Usage: notion write <path> <content>' };
  }

  const path = args[0];
  const content = options.content || args.slice(1).join(' ');

  if (!content) {
    return { success: false, error: 'Missing content. Usage: notion write <path> <content> or notion write <path> --content "content"' };
  }

  // Check if page was read before and validate it's still up-to-date
  const readState = getReadState(path);
  if (readState) {
    const currentMetadata = await fs.getPageMetadata(path);

    if (currentMetadata.lastModifiedTime !== readState.lastModifiedTime) {
      return {
        success: false,
        error: `Page "${path}" has been updated since it was last read. Last read: ${readState.lastModifiedTime}, Current: ${currentMetadata.lastModifiedTime}. Please read the page again before writing.`,
      };
    }
  }

  await fs.writeFile(path, content);

  // Update read state after successful write
  const pageId = await (fs as any).resolvePath(path);
  const currentMetadata = await fs.getPageMetadata(path);
  updateReadState(path, {
    path,
    pageId,
    lastModifiedTime: currentMetadata.lastModifiedTime,
  });

  return { success: true, data: { path, message: 'Content written successfully' } };
}

/**
 * Handle: notion append <path> <content>
 */
async function handleAppend(
  fs: NotionFileSystem,
  args: string[],
  options: Record<string, string>,
  client: NotionClient
): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing path. Usage: notion append <path> <content>' };
  }

  const path = args[0];
  const content = options.content || args.slice(1).join(' ');

  if (!content) {
    return { success: false, error: 'Missing content. Usage: notion append <path> <content> or notion append <path> --content "content"' };
  }

  await fs.appendFile(path, content);

  // Update read state after successful append
  const pageId = await (fs as any).resolvePath(path);
  const currentMetadata = await fs.getPageMetadata(path);
  updateReadState(path, {
    path,
    pageId,
    lastModifiedTime: currentMetadata.lastModifiedTime,
  });

  return { success: true, data: { path, message: 'Content appended successfully' } };
}

/**
 * Handle: notion patch <path> <changes>
 */
async function handlePatch(
  fs: NotionFileSystem,
  args: string[],
  options: Record<string, string>,
  client: NotionClient
): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing path. Usage: notion patch <path> <changes>' };
  }

  const path = args[0];
  const changes = options.content || args.slice(1).join(' ');

  if (!changes) {
    return { success: false, error: 'Missing changes. Usage: notion patch <path> <changes> or notion patch <path> --content "changes"' };
  }

  // Check if page was read before and validate it's still up-to-date
  const readState = getReadState(path);
  if (readState) {
    const currentMetadata = await fs.getPageMetadata(path);

    if (currentMetadata.lastModifiedTime !== readState.lastModifiedTime) {
      return {
        success: false,
        error: `Page "${path}" has been updated since it was last read. Last read: ${readState.lastModifiedTime}, Current: ${currentMetadata.lastModifiedTime}. Please read the page again before patching.`,
      };
    }
  }

  await fs.patchFile(path, changes);

  // Update read state after successful patch
  const pageId = await (fs as any).resolvePath(path);
  const currentMetadata = await fs.getPageMetadata(path);
  updateReadState(path, {
    path,
    pageId,
    lastModifiedTime: currentMetadata.lastModifiedTime,
  });

  return { success: true, data: { path, message: 'Content patched successfully' } };
}

/**
 * Handle: notion list <path>
 */
async function handleList(fs: NotionFileSystem, args: string[], options: Record<string, string>): Promise<CommandResult> {
  const path = args[0] || '/notion/';

  const entries = await fs.listFiles(path);

  return {
    success: true,
    data: {
      path,
      entries,
      count: entries.length,
    },
  };
}

/**
 * Handle: notion search <query>
 */
async function handleSearch(fs: NotionFileSystem, args: string[], options: Record<string, string>): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing query. Usage: notion search <query> [--type <page|database>]' };
  }

  const query = args.join(' ');
  const type = options.type as 'page' | 'database' | undefined;

  const results = await fs.searchFiles(query, type);

  return {
    success: true,
    data: {
      query,
      type: type || 'all',
      results,
      count: results.length,
    },
  };
}

/**
 * Handle: notion databases <subcommand>
 */
async function handleDatabases(client: NotionClient, args: string[], options: Record<string, string>): Promise<CommandResult> {
  const subcommand = args[0];

  if (!subcommand) {
    return {
      success: false,
      error: 'Missing database subcommand. Usage: notion databases <get|query> [options]',
    };
  }

  switch (subcommand) {
    case 'get':
      return await handleDatabaseGet(client, args.slice(1), options);
    case 'query':
      return await handleDatabaseQuery(client, args.slice(1), options);
    default:
      return {
        success: false,
        error: `Unknown database subcommand: ${subcommand}. Valid subcommands: get, query`,
      };
  }
}

/**
 * Handle: notion databases get <id>
 */
async function handleDatabaseGet(client: NotionClient, args: string[], options: Record<string, string>): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing database ID. Usage: notion databases get <id>' };
  }

  const databaseId = args[0];
  const database = await client.getDatabase(databaseId);

  return { success: true, data: database };
}

/**
 * Handle: notion databases query <id>
 */
async function handleDatabaseQuery(client: NotionClient, args: string[], options: Record<string, string>): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing database ID. Usage: notion databases query <id> [--filter <json>] [--sorts <json>]' };
  }

  const databaseId = args[0];

  const queryOptions: DatabaseQueryOptions = {};

  if (options.filter) {
    try {
      queryOptions.filter = JSON.parse(options.filter);
    } catch (error) {
      return { success: false, error: 'Invalid filter JSON. Use valid JSON format.' };
    }
  }

  if (options.sorts) {
    try {
      queryOptions.sorts = JSON.parse(options.sorts);
    } catch (error) {
      return { success: false, error: 'Invalid sorts JSON. Use valid JSON format.' };
    }
  }

  const result = await client.queryDatabase(databaseId, queryOptions);

  return {
    success: true,
    data: {
      databaseId,
      results: result.results,
      count: result.results.length,
      hasMore: result.has_more,
      nextCursor: result.next_cursor,
    },
  };
}

/**
 * Handle: notion comments <subcommand>
 */
async function handleComments(client: NotionClient, args: string[], options: Record<string, string>): Promise<CommandResult> {
  const subcommand = args[0];

  if (!subcommand) {
    return {
      success: false,
      error: 'Missing comment subcommand. Usage: notion comments <list|add> [options]',
    };
  }

  switch (subcommand) {
    case 'list':
      return await handleCommentList(client, args.slice(1), options);
    case 'add':
      return await handleCommentAdd(client, args.slice(1), options);
    default:
      return {
        success: false,
        error: `Unknown comment subcommand: ${subcommand}. Valid subcommands: list, add`,
      };
  }
}

/**
 * Handle: notion comments list <page_id>
 */
async function handleCommentList(client: NotionClient, args: string[], options: Record<string, string>): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing page ID. Usage: notion comments list <page_id>' };
  }

  const pageId = args[0];
  const comments = await client.listComments(pageId);

  return {
    success: true,
    data: {
      pageId,
      comments,
      count: comments.length,
    },
  };
}

/**
 * Handle: notion comments add <page_id> --body <text>
 */
async function handleCommentAdd(client: NotionClient, args: string[], options: Record<string, string>): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, error: 'Missing page ID. Usage: notion comments add <page_id> --body <text>' };
  }

  const pageId = args[0];
  const body = options.body;

  if (!body) {
    return { success: false, error: 'Missing comment body. Usage: notion comments add <page_id> --body <text>' };
  }

  const comment = await client.addComment(pageId, body);

  return {
    success: true,
    data: {
      pageId,
      comment,
      message: 'Comment added successfully',
    },
  };
}
