/**
 * TypeScript types for Notion API responses and requests
 */

export interface NotionPage {
  object: 'page';
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  properties: Record<string, any>;
  parent: {
    type: 'workspace' | 'page_id' | 'database_id' | 'block_id';
    page_id?: string;
    database_id?: string;
    block_id?: string;
  };
  url: string;
}

export interface NotionDatabase {
  object: 'database' | 'data_source';
  id: string;
  created_time: string;
  last_edited_time: string;
  title: Array<{ type: 'text'; text: { content: string } }>;
  properties: Record<string, any>;
  parent: {
    type: 'workspace' | 'page_id';
    page_id?: string;
  };
}

export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  has_children: boolean;
  parent: {
    type: 'workspace' | 'page_id' | 'database_id' | 'block_id';
    page_id?: string;
    database_id?: string;
    block_id?: string;
  };
  [key: string]: any; // Block-specific properties
}

export interface NotionComment {
  object: 'comment';
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  parent: {
    type: 'page_id' | 'discussion_id';
    page_id?: string;
    discussion_id?: string;
  };
  discussion_id: string;
  rich_text: Array<{ type: 'text'; text: { content: string; link?: { url: string } } }>;
  created_by: {
    object: 'user';
    id: string;
  };
}

export interface SearchResult {
  object: 'page' | 'database' | 'data_source';
  id: string;
  title?: string;
  properties?: Record<string, any>;
  parent?: {
    type: 'workspace' | 'page_id' | 'database_id';
    page_id?: string;
    database_id?: string;
  };
  url?: string;
}

export interface NotionError {
  code: string;
  message: string;
  status: number;
}

export interface MarkdownContent {
  markdown: string;
}

export interface QueryFilter {
  property: string;
  [key: string]: any; // Filter-specific properties
}

export interface QuerySort {
  property: string;
  direction: 'ascending' | 'descending';
}

export interface DatabaseQueryOptions {
  filter?: QueryFilter;
  sorts?: QuerySort[];
  start_cursor?: string;
  page_size?: number;
}

/**
 * Session state for tracking page reads and their last modified times
 */
export interface PageReadState {
  path: string;
  pageId: string;
  lastModifiedTime: string;
  localPath?: string;
}

/**
 * Read result with metadata
 */
export interface ReadResult {
  content: string;
  lastModifiedTime: string;
  localPath?: string;
  wasOverridden?: boolean;
}
