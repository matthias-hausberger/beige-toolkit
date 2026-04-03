/**
 * Notion file system abstraction - treats Notion like a local filesystem
 */

import { NotionClient, NotionClientError } from './client.js';
import { NotionPage, NotionBlock, SearchResult, ReadResult } from './types.js';

export interface FileSystemEntry {
  path: string;
  id: string;
  type: 'page' | 'database' | 'file';
  title?: string;
  url?: string;
}

export class NotionFileSystem {
  private client: NotionClient;
  private pathCache: Map<string, string> = new Map();
  private workspaceRootId?: string;
  private notionWorkspacePath: string;

  constructor(client: NotionClient, workspaceRootId?: string, notionWorkspacePath: string = 'notion/') {
    this.client = client;
    this.workspaceRootId = workspaceRootId;
    this.notionWorkspacePath = notionWorkspacePath.endsWith('/') ? notionWorkspacePath : notionWorkspacePath + '/';
  }

  /**
   * Resolve a virtual path to a Notion page/database ID
   * Examples:
   *   /notion/ → workspace root
   *   /notion/tasks/Task-1.md → page ID
   *   /notion/tasks/ → database ID or parent page ID
   */
  async resolvePath(path: string): Promise<string> {
    // Normalize path
    const normalizedPath = path.replace(/^\/notion\/?/, '').replace(/\/$/, '');

    // Root path
    if (normalizedPath === '') {
      if (this.workspaceRootId) {
        return this.workspaceRootId;
      }
      throw new Error('Workspace root not configured. Please set workspaceRootId in config.');
    }

    // Check cache first
    if (this.pathCache.has(normalizedPath)) {
      return this.pathCache.get(normalizedPath)!;
    }

    // Split path into components
    const components = normalizedPath.split('/');
    let currentId: string | undefined;

    if (this.workspaceRootId) {
      currentId = this.workspaceRootId;
    } else {
      // Search for the first component
      const results = await this.client.search(components[0]);
      if (results.length === 0) {
        throw new Error(`Path not found: ${path}`);
      }
      currentId = results[0].id;
    }

    // Traverse the path
    for (let i = 1; i < components.length; i++) {
      const component = components[i];

      // Remove .md extension if present
      const name = component.replace(/\.md$/, '');

      // Get children of current block/page
      const children = await this.client.getBlockChildren(currentId);

      // Find matching child
      const child = children.find((block: NotionBlock) => {
        if (block.type === 'child_page') {
          return block.child_page?.title === name;
        }
        if (block.type === 'child_database') {
          return block.child_database?.title === name;
        }
        return false;
      });

      if (!child) {
        throw new Error(`Path not found: ${path}`);
      }

      currentId = child.id;
    }

    // Cache the result
    this.pathCache.set(normalizedPath, currentId);

    return currentId;
  }

  /**
   * Read a Notion page as Markdown
   */
  async readFile(path: string, downloadToWorkspace: boolean = false): Promise<ReadResult> {
    const pageId = await this.resolvePath(path);
    const { markdown, lastModifiedTime } = await this.client.getPageMarkdownWithMetadata(pageId);

    let localPath: string | undefined;
    let wasOverridden = false;

    if (downloadToWorkspace) {
      // Convert Notion path to local file path
      const normalizedPath = path.replace(/^\/notion\/?/, '');
      localPath = `${this.notionWorkspacePath}${normalizedPath}`;

      // Check if file already exists
      const fs = await import('fs/promises');
      try {
        await fs.access(localPath);
        wasOverridden = true;
      } catch {
        // File doesn't exist, not an override
      }

      // Ensure directory exists
      const dir = localPath.substring(0, localPath.lastIndexOf('/'));
      await fs.mkdir(dir, { recursive: true });

      // Write content to local file
      await fs.writeFile(localPath, markdown, 'utf-8');
    }

    return {
      content: markdown,
      lastModifiedTime,
      localPath,
      wasOverridden,
    };
  }

  /**
   * Get page metadata (last modified time) for validation
   */
  async getPageMetadata(path: string): Promise<{ pageId: string; lastModifiedTime: string }> {
    const pageId = await this.resolvePath(path);
    const page = await this.client.getPage(pageId);
    return {
      pageId,
      lastModifiedTime: page.last_edited_time,
    };
  }

  /**
   * Write content to a Notion page (creates or replaces)
   */
  async writeFile(path: string, content: string): Promise<void> {
    const normalizedPath = path.replace(/^\/notion\/?/, '').replace(/\/$/, '');

    // Check if the path exists
    try {
      const pageId = await this.resolvePath(path);
      // Page exists, update it
      await this.client.updatePageMarkdown(pageId, content);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path not found')) {
        // Page doesn't exist, create it
        await this.createPageAtPath(normalizedPath, content);
      } else {
        throw error;
      }
    }
  }

  /**
   * Append content to a Notion page
   */
  async appendFile(path: string, content: string): Promise<void> {
    const pageId = await this.resolvePath(path);
    await this.client.appendPageMarkdown(pageId, content);
  }

  /**
   * Patch/merge content in a Notion page
   * This is a simplified implementation - for now, it appends
   * A more sophisticated version would use diff/merge algorithms
   */
  async patchFile(path: string, changes: string): Promise<void> {
    const pageId = await this.resolvePath(path);
    await this.client.appendPageMarkdown(pageId, changes);
  }

  /**
   * List child pages/databases under a path
   */
  async listFiles(path: string): Promise<FileSystemEntry[]> {
    const blockId = await this.resolvePath(path);
    const children = await this.client.getBlockChildren(blockId);

    const entries: FileSystemEntry[] = [];

    for (const child of children) {
      let entry: FileSystemEntry;

      if (child.type === 'child_page') {
        const title = child.child_page?.title || 'Untitled';
        entry = {
          path: `${path.replace(/\/$/, '')}/${title}.md`,
          id: child.id,
          type: 'page',
          title,
        };
      } else if (child.type === 'child_database') {
        const title = child.child_database?.title || 'Untitled Database';
        entry = {
          path: `${path.replace(/\/$/, '')}/${title}/`,
          id: child.id,
          type: 'database',
          title,
        };
      } else {
        // Skip other block types
        continue;
      }

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Search for pages and databases
   */
  async searchFiles(query: string, type?: 'page' | 'database'): Promise<FileSystemEntry[]> {
    const filter = type ? { property: 'object', value: type } : undefined;
    const results = await this.client.search(query, filter);

    return results.map((result: SearchResult) => {
      const title = this.extractTitle(result);
      return {
        path: `/notion/${title}${result.object === 'database' ? '/' : '.md'}`,
        id: result.id,
        type: result.object === 'database' ? 'database' : 'page',
        title,
        url: result.url,
      };
    });
  }

  /**
   * Create a page at a given path
   */
  private async createPageAtPath(path: string, content: string): Promise<void> {
    const components = path.split('/');
    const pageName = components.pop()?.replace(/\.md$/, '') || 'Untitled';

    if (components.length === 0) {
      // Creating at root - not supported, need a parent
      throw new Error('Cannot create page at root. Please specify a parent path.');
    }

    // Resolve parent path
    const parentPath = components.join('/');
    const parentId = await this.resolvePath(`/notion/${parentPath}`);

    // Check if parent is a database
    try {
      const parentPage = await this.client.getPage(parentId);
      if (parentPage.parent.type === 'database_id') {
        // Parent is a database page, create in database
        await this.client.createPage(parentPage.parent.database_id!, {
          Name: { title: [{ text: { content: pageName } }] },
        }, content);
      } else {
        throw new Error('Parent is not a database. Page creation only supported in databases.');
      }
    } catch (error) {
      throw new Error(`Failed to create page at ${path}: ${error}`);
    }
  }

  /**
   * Extract title from a search result
   */
  private extractTitle(result: SearchResult): string {
    if (result.title) {
      return result.title;
    }

    if (result.properties) {
      // Try to find a title property
      for (const [key, value] of Object.entries(result.properties)) {
        if (value && typeof value === 'object' && 'title' in value) {
          const title = (value as any).title;
          if (Array.isArray(title) && title[0]?.text?.content) {
            return title[0].text.content;
          }
        }
      }
    }

    return 'Untitled';
  }
}
