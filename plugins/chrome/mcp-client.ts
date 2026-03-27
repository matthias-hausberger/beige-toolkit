/**
 * Minimal MCP stdio client.
 *
 * Speaks the Model Context Protocol (JSON-RPC 2.0) over a pair of Node.js
 * Readable/Writable streams connected to a running MCP server process.
 *
 * Wire format: one JSON object per line (no Content-Length framing).
 * Protocol version negotiated during initialize handshake.
 *
 * Only the subset of MCP needed by the chrome tool is implemented:
 *   - initialize / notifications/initialized  (startup handshake)
 *   - tools/list                              (discover available tools)
 *   - tools/call                              (invoke a tool)
 */

import type { Readable, Writable } from "stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;   // base64
  mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Interface for MCP client — allows tests to stub without implementing the full class.
 */
export interface McpClientLike {
  readonly isClosed: boolean;
  initialize(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpToolCallResult>;
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export class McpClient {
  private stdin: Writable;
  private stdout: Readable;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private initialized = false;
  private closed = false;

  constructor(stdin: Writable, stdout: Readable) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.stdout.setEncoding("utf-8");
    this.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.stdout.on("end", () => this.onEnd());
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Perform the MCP initialize handshake.
   * Must be called once before any tools/call or tools/list requests.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "beige-toolkit-chrome", version: "0.0.1" },
    });

    // Send the initialized notification (fire-and-forget — no response expected)
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  /**
   * List all tools the MCP server exposes.
   */
  async listTools(): Promise<McpTool[]> {
    this.assertInitialized();
    const result = (await this.request("tools/list", {})) as {
      tools?: McpTool[];
    };
    return result.tools ?? [];
  }

  /**
   * Call an MCP tool with the given arguments.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<McpToolCallResult> {
    this.assertInitialized();
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs
    )) as McpToolCallResult;
    return result;
  }

  /** True if the underlying streams have been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("McpClient: not initialized");
    if (this.closed) throw new Error("McpClient: connection closed");
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) throw new Error("McpClient: connection is closed");
    this.stdin.write(JSON.stringify(message) + "\n");
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("McpClient: connection is closed"));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request '${method}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed));
      } catch {
        // Malformed line — ignore (MCP servers sometimes emit log lines)
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response (has id + result or error)
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);

      if (msg.error) {
        const err = msg.error as { code?: number; message?: string };
        reject(new Error(`MCP error ${err.code ?? ""}: ${err.message ?? JSON.stringify(msg.error)}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Server-sent notifications (method without id) — ignore for now
  }

  private onEnd(): void {
    this.closed = true;
    // Reject all pending requests
    for (const [, { reject }] of this.pending) {
      reject(new Error("McpClient: server process closed unexpectedly"));
    }
    this.pending.clear();
  }
}
