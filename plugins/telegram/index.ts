/**
 * Telegram plugin for Beige.
 *
 * Provides:
 * - A **channel adapter** — GrammY bot that routes Telegram messages to agents
 * - A **tool** named "telegram" — allows agents to send proactive messages
 *
 * Config (passed via pluginConfigs or plugins.telegram.config):
 *   token:         Telegram Bot API token
 *   allowedUsers:  Array of allowed Telegram user IDs
 *   agentMapping:  { default: "agentName" }
 *   defaults:      { verbose?: boolean, streaming?: boolean }
 */

import { Bot, type Context } from "grammy";
import type {
  PluginInstance,
  PluginContext,
  PluginRegistrar,
  ChannelAdapter,
  SendMessageOptions,
  ToolResult,
} from "@matthias-hausberger/beige";
import {
  formatChannelError,
  isAllModelsExhausted,
  formatAllModelsExhaustedError,
  getErrorTag,
} from "@matthias-hausberger/beige";

// ── Config types ─────────────────────────────────────────────────────────────

interface TelegramPluginConfig {
  token: string;
  allowedUsers: (number | string)[]; // strings from env vars are coerced to numbers
  agentMapping: { default: string };
  defaults?: {
    verbose?: boolean;
    streaming?: boolean;
  };
}

// ── Session settings helpers ─────────────────────────────────────────────────

function resolveSettingBool(
  sessionMeta: Record<string, unknown> | undefined,
  key: string,
  channelDefault: boolean | undefined,
  systemDefault: boolean
): boolean {
  // Session override (stored in plugin metadata) > channel default > system default
  const sessionOverride = sessionMeta?.[key];
  if (typeof sessionOverride === "boolean") return sessionOverride;
  if (typeof channelDefault === "boolean") return channelDefault;
  return systemDefault;
}

// ── Session key helper ───────────────────────────────────────────────────────

function telegramSessionKey(chatId: number, threadId?: number): string {
  if (threadId !== undefined) {
    return `telegram:${chatId}:${threadId}`;
  }
  return `telegram:${chatId}`;
}

// ── Plugin entry point ───────────────────────────────────────────────────────

export function createPlugin(
  config: Record<string, unknown>,
  ctx: PluginContext
): PluginInstance {
  const cfg = config as unknown as TelegramPluginConfig;

  if (!cfg.token) {
    throw new Error("Telegram plugin requires 'token' in config");
  }
  if (!cfg.allowedUsers?.length) {
    throw new Error("Telegram plugin requires 'allowedUsers' in config");
  }
  if (!cfg.agentMapping?.default) {
    throw new Error("Telegram plugin requires 'agentMapping.default' in config");
  }

  // Coerce string user IDs (from env vars) to numbers
  const allowedUserIds: number[] = cfg.allowedUsers.map((id) =>
    typeof id === "string" ? parseInt(id, 10) : id
  );

  const bot = new Bot(cfg.token);

  // ── Helpers ────────────────────────────────────────────────────────────

  function resolveAgent(_userId: number): string {
    return cfg.agentMapping.default;
  }

  function getVerbose(sessionKey: string): boolean {
    const meta = ctx.getSessionMetadata(sessionKey, "telegram_settings") as
      | Record<string, unknown>
      | undefined;
    return resolveSettingBool(meta, "verbose", cfg.defaults?.verbose, false);
  }

  function getStreaming(sessionKey: string): boolean {
    const meta = ctx.getSessionMetadata(sessionKey, "telegram_settings") as
      | Record<string, unknown>
      | undefined;
    return resolveSettingBool(meta, "streaming", cfg.defaults?.streaming, true);
  }

  function setSetting(sessionKey: string, key: string, value: boolean): void {
    const meta =
      (ctx.getSessionMetadata(sessionKey, "telegram_settings") as Record<string, unknown>) ?? {};
    meta[key] = value;
    ctx.setSessionMetadata(sessionKey, "telegram_settings", meta);
  }

  // ── Tool start handler for verbose mode ────────────────────────────────

  function makeToolStartHandler(
    chatId: number,
    threadId: number | undefined
  ): (toolName: string, params: Record<string, unknown>) => void {
    return (toolName: string, params: Record<string, unknown>) => {
      const label = formatToolCall(toolName, params);
      bot.api
        .sendMessage(chatId, `🔧 ${label}`, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        })
        .catch((err) => {
          ctx.log.warn(`Failed to send verbose notification: ${err}`);
        });
    };
  }

  // ── Concurrency tracking ────────────────────────────────────────────────
  //
  // Tracks sessions that are about to start but whose inflightCount hasn't
  // been incremented yet inside AgentManager — guards the small async window
  // between "fire and forget" and the count becoming visible via isSessionActive().
  const pendingSessions = new Set<string>();

  function isActive(sessionKey: string): boolean {
    return pendingSessions.has(sessionKey) || ctx.isSessionActive(sessionKey);
  }

  // ── Session runner (detached from grammY handler) ───────────────────────
  //
  // Called fire-and-forget from the message handler so grammY is never blocked.
  // Uses bot.api directly since grammyCtx is not available after the handler returns.
  async function runSession(
    chatId: number,
    threadId: number | undefined,
    sessionKey: string,
    agentName: string,
    text: string
  ): Promise<void> {
    const streaming = getStreaming(sessionKey);
    const verbose = getVerbose(sessionKey);
    const onToolStart = verbose ? makeToolStartHandler(chatId, threadId) : undefined;

    try {
      // Typing indicator — immediate feedback
      await bot.api.sendChatAction(chatId, "typing", {
        ...(threadId ? { message_thread_id: threadId } : {}),
      }).catch(() => {}); // non-fatal if it fails

      if (streaming) {
        // Streaming mode: create a Telegram message and edit it as deltas arrive.
        //
        // When the agent makes tool calls, the LLM may emit a brief text turn
        // before the tools (e.g. "I'll check that..."). onAssistantTurnStart fires
        // each time a new LLM turn begins — we reset currentMessage and delete the
        // partial Telegram message so only the FINAL turn's text is shown.
        let currentMessage = "";
        let sentMessageId: number | null = null;
        let lastUpdateTime = 0;
        const UPDATE_INTERVAL_MS = 1000;

        const response = await ctx.promptStreaming(
          sessionKey,
          agentName,
          text,
          async (delta: string) => {
            currentMessage += delta;

            const now = Date.now();
            if (now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
            lastUpdateTime = now;

            try {
              if (sentMessageId === null) {
                const sent = await bot.api.sendMessage(
                  chatId,
                  truncateForTelegram(currentMessage),
                  { ...(threadId ? { message_thread_id: threadId } : {}) }
                );
                sentMessageId = sent.message_id;
              } else {
                await bot.api.editMessageText(
                  chatId,
                  sentMessageId,
                  truncateForTelegram(currentMessage)
                );
              }
            } catch {
              // Ignore edit errors — Telegram rejects edits if content unchanged
            }
          },
          {
            onToolStart,
            channel: "telegram",
            onAssistantTurnStart: () => {
              // New LLM turn starting — discard any partial message from the
              // previous turn (which was pre-tool-call chatter, not the final answer).
              if (sentMessageId !== null) {
                bot.api
                  .deleteMessage(chatId, sentMessageId)
                  .catch(() => {}); // non-fatal if already gone
                sentMessageId = null;
              }
              currentMessage = "";
              lastUpdateTime = 0;
            },
          }
        );

        // Final edit with the complete response
        if (sentMessageId !== null) {
          try {
            await bot.api.editMessageText(
              chatId,
              sentMessageId,
              truncateForTelegram(response)
            );
          } catch {
            // Edit failed (e.g. identical content) — send as new message
            await sendLongMessageTo(chatId, threadId, response);
          }
        } else {
          await sendLongMessageTo(chatId, threadId, response);
        }
      } else {
        // Non-streaming mode: wait for full response then send
        const response = await ctx.prompt(sessionKey, agentName, text, {
          onToolStart,
          channel: "telegram",
        });
        await sendLongMessageTo(chatId, threadId, response);
      }
    } catch (err) {
      const errorTag = getErrorTag(err);
      ctx.log.error(`[${errorTag}] Session error [${sessionKey}]: ${err}`);

      let errorMessage: string;
      if (isAllModelsExhausted(err)) {
        errorMessage = formatAllModelsExhaustedError(err);
      } else {
        errorMessage = formatChannelError(err, false);
      }

      await bot.api
        .sendMessage(chatId, errorMessage, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        })
        .catch(() => {});
    }
  }

  // ── Bot-level sendLongMessage (no grammyCtx needed) ─────────────────────

  async function sendLongMessageTo(
    chatId: number,
    threadId: number | undefined,
    text: string
  ): Promise<void> {
    const chunks = splitMessage(text || "(empty response)", 4096);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk, {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }

  // ── Bot handlers ───────────────────────────────────────────────────────

  // Auth middleware
  bot.use(async (grammyCtx, next) => {
    const userId = grammyCtx.from?.id;
    if (!userId || !allowedUserIds.includes(userId)) {
      ctx.log.info(`Unauthorized user: ${userId}`);
      await grammyCtx.reply("⛔ Unauthorized.");
      return;
    }
    await next();
  });

  // /start command
  bot.command("start", async (grammyCtx) => {
    const sessionKey = telegramSessionKey(
      grammyCtx.chat.id,
      grammyCtx.message?.message_thread_id
    );
    const verbose = getVerbose(sessionKey);
    const streaming = getStreaming(sessionKey);
    await grammyCtx.reply(
      "👋 Hello! I'm your Beige agent. Send me a message and I'll help you out.\n\n" +
        "Commands:\n" +
        "/new — Start a new conversation session\n" +
        "/stop — Abort the current operation immediately\n" +
        "/status — Show current session info and settings\n" +
        "/verbose on|off — Toggle tool-call notifications\n" +
        "/v on|off — Same as /verbose (shorthand)\n" +
        "/streaming on|off — Toggle real-time response streaming\n" +
        "/s on|off — Same as /streaming (shorthand)\n\n" +
        "Tips:\n" +
        "• Send a message while the agent is running to steer it mid-task\n" +
        "• Multiple threads run as independent sessions in parallel\n\n" +
        `Current settings:\n` +
        `• Verbose: ${verbose ? "🔊 on" : "🔇 off"}\n` +
        `• Streaming: ${streaming ? "⚡ on" : "📦 off"}`
    );
  });

  // /new command
  bot.command("new", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(grammyCtx.from!.id);

    // Clear session-level setting overrides
    ctx.setSessionMetadata(sessionKey, "telegram_settings", {});

    await ctx.newSession(sessionKey, agentName);
    await grammyCtx.reply("🆕 New session started. Previous conversation is saved.");
  });

  // /stop command — abort the current session operation immediately
  bot.command("stop", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);

    if (!isActive(sessionKey)) {
      await grammyCtx.reply("No active operation to stop.");
      return;
    }

    await ctx.abortSession(sessionKey);
    await grammyCtx.reply("⛔ Stopped.");
    ctx.log.info(`Session aborted by user: ${sessionKey}`);
  });

  // /status command
  bot.command("status", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(grammyCtx.from!.id);
    const verbose = getVerbose(sessionKey);
    const streaming = getStreaming(sessionKey);

    // ── Model & context usage ──────────────────────────────
    // Read model and usage directly from the session file — model_change entries
    // are written by pi and are always present; session metadata _model is not.
    const modelRef = ctx.getSessionModel(sessionKey);
    const usage = ctx.getSessionUsage(sessionKey);

    let modelLine = "_(no session yet)_";
    let contextLine = "_(no data yet)_";

    if (modelRef) {
      const modelInfo = ctx.getModel(modelRef.provider, modelRef.modelId);
      modelLine = modelInfo
        ? `\`${modelInfo.name}\``
        : `\`${modelRef.provider}/${modelRef.modelId}\``;

      if (usage && modelInfo) {
        const pct = ((usage.inputTokens / modelInfo.contextWindow) * 100).toFixed(1);
        const usedK = (usage.inputTokens / 1000).toFixed(1);
        const maxK = (modelInfo.contextWindow / 1000).toFixed(0);
        const bar = contextBar(usage.inputTokens, modelInfo.contextWindow);
        contextLine = `${bar} ${usedK}k / ${maxK}k (${pct}%)`;
      } else if (usage) {
        // Model known but not in registry (custom/unknown) — show raw token count
        contextLine = `${usage.inputTokens.toLocaleString()} tokens used`;
      }
    }

    await grammyCtx.reply(
      `*Session Status*\n\n` +
        `Agent: \`${agentName}\`\n` +
        `Chat: \`${chatId}${threadId ? ` / Thread: ${threadId}` : ""}\`\n` +
        `Model: ${modelLine}\n\n` +
        `*Context*\n` +
        `${contextLine}\n\n` +
        `*Settings*\n` +
        `• Verbose: ${verbose ? "🔊 on" : "🔇 off"}\n` +
        `• Streaming: ${streaming ? "⚡ on" : "📦 off"}`,
      { parse_mode: "Markdown" }
    );
  });

  // /verbose and /v commands
  async function handleVerboseCommand(grammyCtx: Context): Promise<void> {
    const chatId = grammyCtx.chat!.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);

    const text = grammyCtx.message?.text ?? "";
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();

    if (!arg || (arg !== "on" && arg !== "off")) {
      const current = getVerbose(sessionKey);
      await grammyCtx.reply(`Usage: /verbose on|off\n\nCurrent: ${current ? "🔊 on" : "🔇 off"}`);
      return;
    }

    const enable = arg === "on";
    setSetting(sessionKey, "verbose", enable);

    await grammyCtx.reply(
      enable
        ? "🔊 Verbose mode *on* — you'll see tool calls as they happen."
        : "🔇 Verbose mode *off* — tool calls are hidden.",
      { parse_mode: "Markdown" }
    );
    ctx.log.info(`Verbose mode ${enable ? "ON" : "OFF"} for session ${sessionKey}`);
  }

  bot.command("verbose", handleVerboseCommand);
  bot.command("v", handleVerboseCommand);

  // /streaming and /s commands
  async function handleStreamingCommand(grammyCtx: Context): Promise<void> {
    const chatId = grammyCtx.chat!.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);

    const text = grammyCtx.message?.text ?? "";
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();

    if (!arg || (arg !== "on" && arg !== "off")) {
      const current = getStreaming(sessionKey);
      await grammyCtx.reply(
        `Usage: /streaming on|off\n\nCurrent: ${current ? "⚡ on" : "📦 off"}`
      );
      return;
    }

    const enable = arg === "on";
    setSetting(sessionKey, "streaming", enable);

    await grammyCtx.reply(
      enable
        ? "⚡ Streaming mode *on* — responses will appear in real-time."
        : "📦 Streaming mode *off* — full response will be sent once complete.",
      { parse_mode: "Markdown" }
    );
    ctx.log.info(`Streaming mode ${enable ? "ON" : "OFF"} for session ${sessionKey}`);
  }

  bot.command("streaming", handleStreamingCommand);
  bot.command("s", handleStreamingCommand);

  // Text messages — the main handler
  //
  // The handler returns immediately so grammY is never blocked. The actual
  // prompt runs inside runSession() (fire-and-forget). If a session is already
  // running for this chat/thread, the new message steers it instead.
  bot.on("message:text", async (grammyCtx) => {
    const text = grammyCtx.message.text;
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const userId = grammyCtx.from.id;

    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(userId);

    ctx.log.info(
      `User ${userId} → agent '${agentName}' ` +
        `(chat:${chatId}${threadId ? `/thread:${threadId}` : ""}): ` +
        `${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`
    );

    // If a session is already running, steer it with the new message
    if (isActive(sessionKey)) {
      ctx.log.info(`Steering active session: ${sessionKey}`);
      await ctx.steerSession(sessionKey, text);
      return;
    }

    // Mark as pending immediately — before any await — so the next incoming
    // message sees this session as active even before inflightCount is set.
    pendingSessions.add(sessionKey);

    // Give immediate typing feedback, then fire-and-forget the session
    await grammyCtx.replyWithChatAction("typing").catch(() => {});

    runSession(chatId, threadId, sessionKey, agentName, text)
      .catch((err) => ctx.log.error(`Unhandled session error [${sessionKey}]: ${err}`))
      .finally(() => pendingSessions.delete(sessionKey));
  });

  // ── Channel adapter ────────────────────────────────────────────────────

  const channelAdapter: ChannelAdapter = {
    supportsMessaging(): boolean {
      return true;
    },

    async sendMessage(
      chatId: string,
      threadId: string | undefined,
      text: string,
      options?: SendMessageOptions
    ): Promise<void> {
      const chunks = splitMessage(text, 4096);
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk, {
          parse_mode:
            options?.parseMode === "markdown"
              ? "MarkdownV2"
              : options?.parseMode === "html"
                ? "HTML"
                : undefined,
          ...(threadId ? { message_thread_id: parseInt(threadId, 10) } : {}),
        });
      }
    },
  };

  // ── Tool handler: "telegram" ───────────────────────────────────────────

  async function telegramToolHandler(
    args: string[],
    _config?: Record<string, unknown>
  ): Promise<ToolResult> {
    if (args.length === 0) {
      return {
        output:
          "Usage:\n" +
          "  telegram sendMessage <chatId> <text>\n" +
          "  telegram sendMessage <chatId> --thread <threadId> <text>",
        exitCode: 1,
      };
    }

    const subcommand = args[0];

    switch (subcommand) {
      case "sendMessage":
      case "send_message":
      case "send": {
        if (args.length < 3) {
          return {
            output: "Usage: telegram sendMessage <chatId> <text>\n       telegram sendMessage <chatId> --thread <threadId> <text>",
            exitCode: 1,
          };
        }

        const chatId = args[1];
        let threadId: string | undefined;
        let textStart = 2;

        // Parse --thread option
        if (args[2] === "--thread" && args.length >= 5) {
          threadId = args[3];
          textStart = 4;
        }

        const text = args.slice(textStart).join(" ");
        if (!text) {
          return { output: "Error: message text cannot be empty", exitCode: 1 };
        }

        try {
          await channelAdapter.sendMessage(chatId, threadId, text);
          return {
            output: `Message sent to chat ${chatId}${threadId ? ` (thread ${threadId})` : ""}`,
            exitCode: 0,
          };
        } catch (err) {
          return {
            output: `Failed to send message: ${err instanceof Error ? err.message : err}`,
            exitCode: 1,
          };
        }
      }

      default:
        return {
          output: `Unknown subcommand: ${subcommand}\nAvailable: sendMessage`,
          exitCode: 1,
        };
    }
  }

  // ── Plugin instance ────────────────────────────────────────────────────

  return {
    register(reg: PluginRegistrar): void {
      // Register the channel adapter
      reg.channel(channelAdapter);

      // Register the telegram tool (allows agents to send proactive messages)
      reg.tool({
        name: "telegram",
        description:
          "Send messages to Telegram chats. Use this to proactively notify users.",
        commands: [
          "sendMessage <chatId> <text>               — Send a message to a chat",
          "sendMessage <chatId> --thread <id> <text>  — Send to a specific thread",
        ],
        handler: telegramToolHandler,
      });
    },

    async start(): Promise<void> {
      ctx.log.info("Starting Telegram bot...");

      // Register bot commands with Telegram
      try {
        await bot.api.deleteMyCommands();
        await bot.api.setMyCommands([
          { command: "start", description: "Show welcome message and available commands" },
          { command: "new", description: "Start a new conversation session" },
          { command: "stop", description: "Abort the current operation immediately" },
          { command: "status", description: "Show current session info and settings" },
          { command: "verbose", description: "Toggle tool-call notifications: /verbose on|off" },
          { command: "v", description: "Shorthand for /verbose: /v on|off" },
          { command: "streaming", description: "Toggle real-time streaming: /streaming on|off" },
          { command: "s", description: "Shorthand for /streaming: /s on|off" },
        ]);
        ctx.log.info("Registered bot commands");
      } catch (err) {
        ctx.log.warn(`Failed to register commands: ${err}`);
      }

      // Start long-polling (non-blocking)
      bot.start({
        onStart: (botInfo) => {
          ctx.log.info(`Bot started as @${botInfo.username}`);
        },
      });
    },

    async stop(): Promise<void> {
      // Add timeout to prevent hanging on graceful shutdown (GrammY can be slow)
      await Promise.race([
        bot.stop(),
        new Promise<void>((resolve) => setTimeout(() => resolve(), 1000)),
      ]);
      ctx.log.info("Bot stopped");
    },
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Render a compact ASCII progress bar for context window usage.
 * e.g. "▓▓▓▓▓▓░░░░" for ~60% used.
 */
function contextBar(used: number, total: number, width = 10): string {
  const ratio = Math.min(used / total, 1);
  const filled = Math.round(ratio * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function formatToolCall(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "exec": {
      const cmd = String(params.command ?? "");
      return `exec: ${cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd}`;
    }
    case "read":
      return `read: ${String(params.path ?? "")}`;
    case "write": {
      const path = String(params.path ?? "");
      const bytes = params.bytes != null ? ` (${params.bytes} bytes)` : "";
      return `write: ${path}${bytes}`;
    }
    case "patch":
      return `patch: ${String(params.path ?? "")}`;
    default:
      return `${toolName}: ${JSON.stringify(params).slice(0, 80)}`;
  }
}

function truncateForTelegram(text: string): string {
  if (text.length <= 4096) return text;
  return text.slice(0, 4090) + "\n[…]";
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) chunks.push(current);
      // If a single line exceeds maxLength, split it
      if (line.length > maxLength) {
        for (let i = 0; i < line.length; i += maxLength) {
          chunks.push(line.slice(i, i + maxLength));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendLongMessage(
  grammyCtx: Context,
  text: string,
  threadId?: number
): Promise<void> {
  const chunks = splitMessage(text || "(empty response)", 4096);
  for (const chunk of chunks) {
    await grammyCtx.reply(chunk, {
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }
}
