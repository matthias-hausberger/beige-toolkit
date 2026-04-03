/**
 * Notion API client with rate limiting and retry logic
 */

import {
  NotionPage,
  NotionDatabase,
  NotionBlock,
  NotionComment,
  SearchResult,
  MarkdownContent,
  DatabaseQueryOptions,
  NotionError,
} from './types.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

export class NotionClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(`Notion API Error [${code}]: ${message}`);
    this.name = 'NotionClientError';
  }
}

export class RateLimitError extends NotionClientError {
  public retryAfter: number;

  constructor(retryAfter: number) {
    super(
      'rate_limited',
      `Rate limited. Retry after ${retryAfter} seconds.`,
      429
    );
    this.retryAfter = retryAfter;
    this.name = 'RateLimitError';
  }
}

export class NotionClient {
  private apiKey: string;
  private rateLimit: number;
  private lastRequestTime: number = 0;
  private requestQueue: Array<() => Promise<any>> = [];
  private processingQueue: boolean = false;

  constructor(apiKey: string, rateLimit: number = 3) {
    this.apiKey = apiKey;
    this.rateLimit = rateLimit;
  }

  /**
   * Enqueue a request to respect rate limits
   */
  private async enqueueRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await requestFn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  /**
   * Process the request queue with rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.processingQueue = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      const minRequestInterval = 1000 / this.rateLimit;

      if (timeSinceLastRequest < minRequestInterval) {
        await new Promise(resolve =>
          setTimeout(resolve, minRequestInterval - timeSinceLastRequest)
        );
      }

      const request = this.requestQueue.shift();
      if (request) {
        try {
          await request();
        } catch (error) {
          // Error already handled by the request's promise
        }
        this.lastRequestTime = Date.now();
      }
    }

    this.processingQueue = false;
  }

  /**
   * Make a request to the Notion API with retry logic
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${NOTION_API_BASE}${endpoint}`;

    const headers: HeadersInit = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    return this.enqueueRequest(async () => {
      let retries = 0;
      const maxRetries = 3;

      while (retries < maxRetries) {
        try {
          const response = await fetch(url, { ...options, headers });

          if (response.ok) {
            return await response.json();
          }

          const error: NotionError = await response.json();

          if (response.status === 429) {
            const retryAfter = parseInt(
              response.headers.get('Retry-After') || '5',
              10
            );
            throw new RateLimitError(retryAfter);
          }

          throw new NotionClientError(
            error.code || 'unknown_error',
            error.message || 'Unknown error',
            response.status
          );
        } catch (error) {
          if (error instanceof RateLimitError) {
            // Wait for Retry-After seconds
            await new Promise(resolve =>
              setTimeout(resolve, error.retryAfter * 1000)
            );
            continue;
          }

          if (retries < maxRetries - 1) {
            // Exponential backoff for other errors
            const backoff = Math.pow(2, retries) * 1000;
            await new Promise(resolve => setTimeout(resolve, backoff));
            retries++;
            continue;
          }

          throw error;
        }
      }

      throw new Error('Max retries exceeded');
    });
  }

  /**
   * Search for pages and databases
   */
  async search(query: string, filter?: { property: string; value: string }): Promise<SearchResult[]> {
    const body: any = { query };

    if (filter) {
      body.filter = {
        property: 'object',
        value: filter.value,
      };
    }

    const response = await this.request<{ results: SearchResult[] }>('/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return response.results;
  }

  /**
   * Get a page by ID
   */
  async getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${pageId}`);
  }

  /**
   * Get a page as Markdown
   */
  async getPageMarkdown(pageId: string): Promise<string> {
    const response = await this.request<MarkdownContent>(`/pages/${pageId}/markdown`);
    return response.markdown;
  }

  /**
   * Get a page with Markdown and metadata
   */
  async getPageMarkdownWithMetadata(pageId: string): Promise<{
    markdown: string;
    lastModifiedTime: string;
  }> {
    const [page, markdownResponse] = await Promise.all([
      this.request<NotionPage>(`/pages/${pageId}`),
      this.request<MarkdownContent>(`/pages/${pageId}/markdown`),
    ]);

    return {
      markdown: markdownResponse.markdown,
      lastModifiedTime: page.last_edited_time,
    };
  }

  /**
   * Update a page with Markdown content
   */
  async updatePageMarkdown(pageId: string, markdown: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${pageId}/markdown`, {
      method: 'PATCH',
      body: JSON.stringify({ markdown }),
    });
  }

  /**
   * Append Markdown content to a page
   */
  async appendPageMarkdown(pageId: string, markdown: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${pageId}/markdown`, {
      method: 'PATCH',
      body: JSON.stringify({ markdown, append: true }),
    });
  }

  /**
   * Create a new page
   */
  async createPage(parentId: string, properties: Record<string, any>, content?: string): Promise<NotionPage> {
    const body: any = {
      parent: { database_id: parentId },
      properties,
    };

    // If content is provided, create the page first, then add content
    const page = await this.request<NotionPage>('/pages', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (content) {
      await this.updatePageMarkdown(page.id, content);
    }

    return page;
  }

  /**
   * Get block children (for listing child pages)
   */
  async getBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const response = await this.request<{ results: NotionBlock[] }>(`/blocks/${blockId}/children`);
    return response.results;
  }

  /**
   * Get a database by ID
   */
  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.request<NotionDatabase>(`/databases/${databaseId}`);
  }

  /**
   * Query a database
   */
  async queryDatabase(databaseId: string, options?: DatabaseQueryOptions): Promise<{
    results: NotionPage[];
    next_cursor: string | null;
    has_more: boolean;
  }> {
    const body: any = {};

    if (options?.filter) {
      body.filter = options.filter;
    }

    if (options?.sorts) {
      body.sorts = options.sorts;
    }

    if (options?.start_cursor) {
      body.start_cursor = options.start_cursor;
    }

    if (options?.page_size) {
      body.page_size = options.page_size;
    }

    return this.request(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * List comments on a page
   */
  async listComments(pageId: string): Promise<NotionComment[]> {
    const response = await this.request<{ results: NotionComment[] }>(`/comments`, {
      method: 'POST',
      body: JSON.stringify({ block_id: pageId }),
    });

    return response.results;
  }

  /**
   * Add a comment to a page
   */
  async addComment(pageId: string, text: string): Promise<NotionComment> {
    return this.request<NotionComment>('/comments', {
      method: 'POST',
      body: JSON.stringify({
        parent: { page_id: pageId },
        rich_text: [{ type: 'text', text: { content: text } }],
      }),
    });
  }
}
