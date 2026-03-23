/**
 * Telegram Tool for Beige agents
 *
 * Send messages, photos, documents, and more to Telegram users and groups.
 * Supports threads (topics) in supergroups, markdown formatting, and reply-to.
 *
 * ── Configuration ─────────────────────────────────────────────────────────────
 *
 * Required:
 *   botToken    — Telegram Bot API token (from @BotFather)
 *
 * Optional:
 *   defaultChatId — Default chat/user ID to send messages to
 *   defaultParseMode — Default parse mode: "MarkdownV2", "Markdown", "HTML", or none
 *   allowChats    — Whitelist of chat IDs that can be messaged
 *   denyChats     — Blacklist of chat IDs (deny beats allow)
 *   timeout       — Request timeout in seconds (default: 30)
 *
 * ── Command Structure ─────────────────────────────────────────────────────────
 *
 * All commands follow: telegram <subcommand> [args...]
 *
 * The tool uses curl to call the Telegram Bot API directly from the gateway host.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  botToken?: string;
  defaultChatId?: string | number;
  defaultParseMode?: "MarkdownV2" | "Markdown" | "HTML";
  allowChats?: (string | number)[];
  denyChats?: (string | number)[];
  timeout?: number;
}

export interface ParsedCommand {
  subcommand: string;
  args: Record<string, string | number | boolean>;
  rawArgs: string[];
}

export interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

// ---------------------------------------------------------------------------
// API URL builder
// ---------------------------------------------------------------------------

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

function normalizeChatId(chatId: string | number): string {
  return String(chatId);
}

function isChatAllowed(
  chatId: string | number,
  config: TelegramConfig
): { allowed: boolean; reason?: string } {
  const normalizedId = normalizeChatId(chatId);

  // Check deny list first
  if (config.denyChats) {
    for (const denied of config.denyChats) {
      if (normalizeChatId(denied) === normalizedId) {
        return { allowed: false, reason: `Chat ${chatId} is in deny list` };
      }
    }
  }

  // Check allow list
  if (config.allowChats) {
    let matched = false;
    for (const allowed of config.allowChats) {
      if (normalizeChatId(allowed) === normalizedId) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { allowed: false, reason: `Chat ${chatId} is not in allow list` };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseBoolean(value: string): boolean {
  return value.toLowerCase() === "true" || value === "1" || value.toLowerCase() === "yes";
}

function parseArgs(args: string[]): ParsedCommand {
  if (args.length === 0) {
    return { subcommand: "", args: {}, rawArgs: args };
  }

  const subcommand = args[0];
  const parsed: Record<string, string | number | boolean> = {};
  let i = 1;

  while (i < args.length) {
    const arg = args[i];

    // Handle --key value or --key=value
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      let key: string;
      let value: string;

      if (eqIndex !== -1) {
        key = arg.slice(2, eqIndex);
        value = arg.slice(eqIndex + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        key = arg.slice(2);
        value = args[i + 1];
        i++;
      } else {
        // Boolean flag
        key = arg.slice(2);
        value = "true";
      }

      // Convert numeric values
      if (/^-?\d+$/.test(value)) {
        parsed[key] = parseInt(value, 10);
      } else if (/^-?\d+\.\d+$/.test(value)) {
        parsed[key] = parseFloat(value);
      } else if (value === "true" || value === "false") {
        parsed[key] = parseBoolean(value);
      } else {
        parsed[key] = value;
      }
    }

    i++;
  }

  return { subcommand, args: parsed, rawArgs: args };
}

// ---------------------------------------------------------------------------
// HTTP Request executor using curl
// ---------------------------------------------------------------------------

interface CurlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function executeCurl(
  args: string[],
  timeoutSeconds: number
): Promise<CurlResult> {
  return new Promise((resolve) => {
    const proc = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    // Timeout
    setTimeout(() => {
      proc.kill();
      resolve({
        stdout: "",
        stderr: `Request timed out after ${timeoutSeconds} seconds`,
        exitCode: 1,
      });
    }, timeoutSeconds * 1000);
  });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSendMessage(
  parsed: ParsedCommand,
  config: TelegramConfig
): Promise<{ output: string; exitCode: number }> {
  const chatId = parsed.args.chat ?? parsed.args.chatId ?? config.defaultChatId;
  if (!chatId) {
    return {
      output: "Error: No chat ID specified. Use --chat or configure defaultChatId.",
      exitCode: 1,
    };
  }

  // Ensure chatId is string or number (not boolean)
  if (typeof chatId === "boolean") {
    return {
      output: "Error: Invalid chat ID.",
      exitCode: 1,
    };
  }

  const text = parsed.args.text ?? parsed.args.message;
  if (!text) {
    return { output: "Error: No message text specified. Use --text.", exitCode: 1 };
  }

  // Check permissions
  const permCheck = isChatAllowed(chatId, config);
  if (!permCheck.allowed) {
    return { output: `Permission denied: ${permCheck.reason}`, exitCode: 1 };
  }

  if (!config.botToken) {
    return { output: "Error: botToken not configured.", exitCode: 1 };
  }

  // Build request
  const jsonPayload: Record<string, unknown> = {
    chat_id: chatId,
    text: String(text),
  };

  // Parse mode
  const parseMode = parsed.args.parseMode ?? config.defaultParseMode;
  if (parseMode) {
    jsonPayload.parse_mode = parseMode;
  }

  // Thread/topic support (for supergroups with topics)
  const threadId = parsed.args.thread ?? parsed.args.threadId ?? parsed.args.messageThreadId;
  if (threadId) {
    jsonPayload.message_thread_id = threadId;
  }

  // Reply to message
  if (parsed.args.replyTo) {
    jsonPayload.reply_to_message_id = parsed.args.replyTo;
  }

  // Disable notification
  if (parsed.args.silent || parsed.args.disableNotification) {
    jsonPayload.disable_notification = true;
  }

  // Disable web page preview
  if (parsed.args.disablePreview || parsed.args.disableWebPagePreview) {
    jsonPayload.disable_web_page_preview = true;
  }

  // Execute request
  const url = apiUrl(config.botToken, "sendMessage");
  const curlArgs = [
    "-s",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(jsonPayload),
    "--max-time", String(config.timeout ?? 30),
    url,
  ];

  const result = await executeCurl(curlArgs, config.timeout ?? 30);

  if (result.exitCode !== 0) {
    return { output: `Error: ${result.stderr || result.stdout}`, exitCode: 1 };
  }

  try {
    const response: TelegramResponse = JSON.parse(result.stdout);
    if (!response.ok) {
      return {
        output: `Telegram API error: ${response.description} (code ${response.error_code})`,
        exitCode: 1,
      };
    }
    return { output: `Message sent successfully to chat ${chatId}`, exitCode: 0 };
  } catch {
    return { output: `Unexpected response: ${result.stdout}`, exitCode: 1 };
  }
}

async function handleSendPhoto(
  parsed: ParsedCommand,
  config: TelegramConfig
): Promise<{ output: string; exitCode: number }> {
  const chatId = parsed.args.chat ?? parsed.args.chatId ?? config.defaultChatId;
  if (!chatId) {
    return {
      output: "Error: No chat ID specified. Use --chat or configure defaultChatId.",
      exitCode: 1,
    };
  }

  // Ensure chatId is string or number (not boolean)
  if (typeof chatId === "boolean") {
    return {
      output: "Error: Invalid chat ID.",
      exitCode: 1,
    };
  }

  const photo = parsed.args.photo ?? parsed.args.url ?? parsed.args.file;
  if (!photo) {
    return { output: "Error: No photo specified. Use --photo with a URL or file path.", exitCode: 1 };
  }

  // Check permissions
  const permCheck = isChatAllowed(chatId, config);
  if (!permCheck.allowed) {
    return { output: `Permission denied: ${permCheck.reason}`, exitCode: 1 };
  }

  if (!config.botToken) {
    return { output: "Error: botToken not configured.", exitCode: 1 };
  }

  // Build request
  const jsonPayload: Record<string, unknown> = {
    chat_id: chatId,
    photo: String(photo),
  };

  // Caption
  if (parsed.args.caption) {
    jsonPayload.caption = String(parsed.args.caption);
  }

  // Parse mode for caption
  const parseMode = parsed.args.parseMode ?? config.defaultParseMode;
  if (parseMode && parsed.args.caption) {
    jsonPayload.parse_mode = parseMode;
  }

  // Thread/topic support
  const threadId = parsed.args.thread ?? parsed.args.threadId ?? parsed.args.messageThreadId;
  if (threadId) {
    jsonPayload.message_thread_id = threadId;
  }

  // Reply to message
  if (parsed.args.replyTo) {
    jsonPayload.reply_to_message_id = parsed.args.replyTo;
  }

  // Disable notification
  if (parsed.args.silent || parsed.args.disableNotification) {
    jsonPayload.disable_notification = true;
  }

  // Execute request
  const url = apiUrl(config.botToken, "sendPhoto");
  const curlArgs = [
    "-s",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(jsonPayload),
    "--max-time", String(config.timeout ?? 30),
    url,
  ];

  const result = await executeCurl(curlArgs, config.timeout ?? 30);

  if (result.exitCode !== 0) {
    return { output: `Error: ${result.stderr || result.stdout}`, exitCode: 1 };
  }

  try {
    const response: TelegramResponse = JSON.parse(result.stdout);
    if (!response.ok) {
      return {
        output: `Telegram API error: ${response.description} (code ${response.error_code})`,
        exitCode: 1,
      };
    }
    return { output: `Photo sent successfully to chat ${chatId}`, exitCode: 0 };
  } catch {
    return { output: `Unexpected response: ${result.stdout}`, exitCode: 1 };
  }
}

async function handleSendDocument(
  parsed: ParsedCommand,
  config: TelegramConfig
): Promise<{ output: string; exitCode: number }> {
  const chatId = parsed.args.chat ?? parsed.args.chatId ?? config.defaultChatId;
  if (!chatId) {
    return {
      output: "Error: No chat ID specified. Use --chat or configure defaultChatId.",
      exitCode: 1,
    };
  }

  // Ensure chatId is string or number (not boolean)
  if (typeof chatId === "boolean") {
    return {
      output: "Error: Invalid chat ID.",
      exitCode: 1,
    };
  }

  const docUrl = parsed.args.document ?? parsed.args.url ?? parsed.args.file;
  if (!docUrl) {
    return { output: "Error: No document specified. Use --document with a URL or file_id.", exitCode: 1 };
  }

  // Check permissions
  const permCheck = isChatAllowed(chatId, config);
  if (!permCheck.allowed) {
    return { output: `Permission denied: ${permCheck.reason}`, exitCode: 1 };
  }

  if (!config.botToken) {
    return { output: "Error: botToken not configured.", exitCode: 1 };
  }

  // Build request
  const jsonPayload: Record<string, unknown> = {
    chat_id: chatId,
    document: String(docUrl),
  };

  // Caption
  if (parsed.args.caption) {
    jsonPayload.caption = String(parsed.args.caption);
  }

  // Parse mode for caption
  const parseMode = parsed.args.parseMode ?? config.defaultParseMode;
  if (parseMode && parsed.args.caption) {
    jsonPayload.parse_mode = parseMode;
  }

  // Thread/topic support
  const docThreadId = parsed.args.thread ?? parsed.args.threadId ?? parsed.args.messageThreadId;
  if (docThreadId) {
    jsonPayload.message_thread_id = docThreadId;
  }

  // Reply to message
  if (parsed.args.replyTo) {
    jsonPayload.reply_to_message_id = parsed.args.replyTo;
  }

  // Disable notification
  if (parsed.args.silent || parsed.args.disableNotification) {
    jsonPayload.disable_notification = true;
  }

  // Execute request
  const url = apiUrl(config.botToken, "sendDocument");
  const curlArgs = [
    "-s",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(jsonPayload),
    "--max-time", String(config.timeout ?? 30),
    url,
  ];

  const result = await executeCurl(curlArgs, config.timeout ?? 30);

  if (result.exitCode !== 0) {
    return { output: `Error: ${result.stderr || result.stdout}`, exitCode: 1 };
  }

  try {
    const response: TelegramResponse = JSON.parse(result.stdout);
    if (!response.ok) {
      return {
        output: `Telegram API error: ${response.description} (code ${response.error_code})`,
        exitCode: 1,
      };
    }
    return { output: `Document sent successfully to chat ${chatId}`, exitCode: 0 };
  } catch {
    return { output: `Unexpected response: ${result.stdout}`, exitCode: 1 };
  }
}

async function handleGetMe(
  config: TelegramConfig
): Promise<{ output: string; exitCode: number }> {
  if (!config.botToken) {
    return { output: "Error: botToken not configured.", exitCode: 1 };
  }

  const url = apiUrl(config.botToken, "getMe");
  const curlArgs = ["-s", "--max-time", String(config.timeout ?? 30), url];

  const result = await executeCurl(curlArgs, config.timeout ?? 30);

  if (result.exitCode !== 0) {
    return { output: `Error: ${result.stderr || result.stdout}`, exitCode: 1 };
  }

  try {
    const response: TelegramResponse = JSON.parse(result.stdout);
    if (!response.ok) {
      return {
        output: `Telegram API error: ${response.description} (code ${response.error_code})`,
        exitCode: 1,
      };
    }
    return { output: JSON.stringify(response.result, null, 2), exitCode: 0 };
  } catch {
    return { output: `Unexpected response: ${result.stdout}`, exitCode: 1 };
  }
}

async function handleGetChat(
  parsed: ParsedCommand,
  config: TelegramConfig
): Promise<{ output: string; exitCode: number }> {
  const chatId = parsed.args.chat ?? parsed.args.chatId ?? config.defaultChatId;
  if (!chatId) {
    return {
      output: "Error: No chat ID specified. Use --chat or configure defaultChatId.",
      exitCode: 1,
    };
  }

  if (!config.botToken) {
    return { output: "Error: botToken not configured.", exitCode: 1 };
  }

  const url = apiUrl(config.botToken, "getChat");
  const curlArgs = [
    "-s",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify({ chat_id: chatId }),
    "--max-time", String(config.timeout ?? 30),
    url,
  ];

  const result = await executeCurl(curlArgs, config.timeout ?? 30);

  if (result.exitCode !== 0) {
    return { output: `Error: ${result.stderr || result.stdout}`, exitCode: 1 };
  }

  try {
    const response: TelegramResponse = JSON.parse(result.stdout);
    if (!response.ok) {
      return {
        output: `Telegram API error: ${response.description} (code ${response.error_code})`,
        exitCode: 1,
      };
    }
    return { output: JSON.stringify(response.result, null, 2), exitCode: 0 };
  } catch {
    return { output: `Unexpected response: ${result.stdout}`, exitCode: 1 };
  }
}

async function handleGetUpdates(
  parsed: ParsedCommand,
  config: TelegramConfig
): Promise<{ output: string; exitCode: number }> {
  if (!config.botToken) {
    return { output: "Error: botToken not configured.", exitCode: 1 };
  }

  const jsonPayload: Record<string, unknown> = {};

  if (parsed.args.offset) {
    jsonPayload.offset = parsed.args.offset;
  }
  if (parsed.args.limit) {
    jsonPayload.limit = parsed.args.limit;
  }
  if (parsed.args.timeout !== undefined) {
    jsonPayload.timeout = parsed.args.timeout;
  }

  const url = apiUrl(config.botToken, "getUpdates");
  const curlArgs = [
    "-s",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(jsonPayload),
    "--max-time", String((config.timeout ?? 30) + (jsonPayload.timeout as number || 0)),
    url,
  ];

  const result = await executeCurl(curlArgs, (config.timeout ?? 30) + (jsonPayload.timeout as number || 0));

  if (result.exitCode !== 0) {
    return { output: `Error: ${result.stderr || result.stdout}`, exitCode: 1 };
  }

  try {
    const response: TelegramResponse = JSON.parse(result.stdout);
    if (!response.ok) {
      return {
        output: `Telegram API error: ${response.description} (code ${response.error_code})`,
        exitCode: 1,
      };
    }
    return { output: JSON.stringify(response.result, null, 2), exitCode: 0 };
  } catch {
    return { output: `Unexpected response: ${result.stdout}`, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function usageText(): string {
  return [
    "Telegram Tool — Send messages and media via Telegram Bot API",
    "",
    "Usage: telegram <subcommand> [options]",
    "",
    "Subcommands:",
    "  send        Send a text message",
    "  photo       Send a photo",
    "  document    Send a document/file",
    "  me          Get bot info",
    "  chat        Get chat info",
    "  updates     Get pending updates",
    "",
    "Send message options:",
    "  --chat <id>       Chat/user ID (or use defaultChatId config)",
    "  --text <message>  Message text to send",
    "  --thread <id>     Thread/topic ID (for supergroups)",
    "  --reply-to <id>   Message ID to reply to",
    "  --parse-mode <mode>  Markdown, MarkdownV2, or HTML",
    "  --silent          Send without notification",
    "  --disable-preview Disable link previews",
    "",
    "Send photo options:",
    "  --chat <id>       Chat/user ID",
    "  --photo <url|file_id>  Photo URL or file_id",
    "  --caption <text>  Photo caption",
    "  --thread <id>     Thread/topic ID",
    "  --reply-to <id>   Message ID to reply to",
    "",
    "Examples:",
    "  telegram send --chat 58687206 --text \"Hello from beige!\"",
    "  telegram send --chat 58687206 --text \"*Bold*\" --parse-mode Markdown",
    "  telegram photo --chat 58687206 --photo https://example.com/image.jpg",
    "  telegram document --chat 58687206 --document https://example.com/file.pdf",
    "  telegram me",
    "  telegram chat --chat 58687206",
    "  telegram updates --limit 10",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

export function createHandler(
  rawConfig: Record<string, unknown>
): (args: string[]) => Promise<{ output: string; exitCode: number }> {
  const config: TelegramConfig = {
    botToken: rawConfig.botToken as string | undefined,
    defaultChatId: rawConfig.defaultChatId as string | number | undefined,
    defaultParseMode: rawConfig.defaultParseMode as "MarkdownV2" | "Markdown" | "HTML" | undefined,
    allowChats: rawConfig.allowChats as (string | number)[] | undefined,
    denyChats: rawConfig.denyChats as (string | number)[] | undefined,
    timeout: (rawConfig.timeout as number) ?? 30,
  };

  return async (args: string[]) => {
    if (args.length === 0) {
      return { output: usageText(), exitCode: 1 };
    }

    const parsed = parseArgs(args);
    const subcommand = parsed.subcommand.toLowerCase();

    switch (subcommand) {
      case "send":
      case "message":
      case "msg":
        return handleSendMessage(parsed, config);

      case "photo":
      case "image":
      case "img":
        return handleSendPhoto(parsed, config);

      case "document":
      case "doc":
      case "file":
        return handleSendDocument(parsed, config);

      case "me":
      case "bot":
      case "self":
        return handleGetMe(config);

      case "chat":
      case "info":
        return handleGetChat(parsed, config);

      case "updates":
      case "poll":
        return handleGetUpdates(parsed, config);

      case "help":
      case "--help":
        return { output: usageText(), exitCode: 0 };

      default:
        return {
          output: `Unknown subcommand: ${subcommand}\n\n${usageText()}`,
          exitCode: 1,
        };
    }
  };
}

// Export utilities for testing
export { isChatAllowed, parseArgs, apiUrl };
