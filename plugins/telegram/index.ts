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

// ── Telegram reaction emoji type ─────────────────────────────────────────────
// Subset of the emoji Telegram accepts as message reactions (as of Bot API 7.x).
// The full set is enforced by the API at runtime; this type just documents the
// ones we actually use and prevents passing arbitrary strings.
type TelegramReactionEmoji = "👀" | "🎉" | "😢";

// ── Config types ─────────────────────────────────────────────────────────────

interface TelegramPluginConfig {
  token: string;
  allowedUsers: (number | string)[]; // strings from env vars are coerced to numbers
  agentMapping: { default: string; [userId: number]: string };
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

  function resolveAgent(userId: number, sessionKey?: string): string {
    // Session-level agent override takes precedence over the default mapping
    if (sessionKey) {
      const meta = ctx.getSessionMetadata(sessionKey, "telegram_settings") as
        | Record<string, unknown>
        | undefined;
      if (typeof meta?.agent === "string") return meta.agent;
    }
    return cfg.agentMapping[userId] ?? cfg.agentMapping.default;
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

  function getModelOverride(sessionKey: string): { provider: string; model: string } | undefined {
    const meta = ctx.getSessionMetadata(sessionKey, "telegram_settings") as
      | Record<string, unknown>
      | undefined;
    const v = meta?.modelOverride;
    if (v && typeof (v as any).provider === "string" && typeof (v as any).model === "string") {
      return v as { provider: string; model: string };
    }
    return undefined;
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

  // ── Reaction helpers ────────────────────────────────────────────────────

  /**
   * Set a single emoji reaction on a user's message.
   * Silently ignores failures (e.g. in channels/supergroups without reactions,
   * or bots without permission to react).
   *
   * Only emoji from Telegram's allowed reaction set are accepted by the API.
   * We use:
   *   👀  — received, being processed
   *   🎉  — finished successfully (no more actions coming)
   *   😢  — processing failed
   */
  function setReaction(
    chatId: number,
    messageId: number,
    emoji: TelegramReactionEmoji
  ): void {
    bot.api
      .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
      .catch(() => {});
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
  //
  // userMessageId: the message_id of the user's message that triggered this session.
  // On success we replace the 👀 reaction with 🎉; on error with 😢.
  async function runSession(
    chatId: number,
    threadId: number | undefined,
    sessionKey: string,
    agentName: string,
    text: string,
    userMessageId: number
  ): Promise<void> {
    const streaming = getStreaming(sessionKey);
    const verbose = getVerbose(sessionKey);
    const onToolStart = verbose ? makeToolStartHandler(chatId, threadId) : undefined;
    const modelOverride = getModelOverride(sessionKey);

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
              // For intermediate streaming updates we always edit/send a single message.
              // Sent as plain text (no parse_mode) — converting incomplete Markdown
              // mid-stream would produce broken HTML. The final message is converted.
              // If the live text exceeds 4096 chars, show the most recent 4096 (a
              // tail-window) so the user sees the latest output as it streams in.
              const preview = currentMessage.length <= 4096
                ? currentMessage
                : "…" + currentMessage.slice(-(4096 - 1));
              if (sentMessageId === null) {
                const sent = await bot.api.sendMessage(
                  chatId,
                  preview,
                  { ...(threadId ? { message_thread_id: threadId } : {}) }
                );
                sentMessageId = sent.message_id;
              } else {
                await bot.api.editMessageText(chatId, sentMessageId, preview);
              }
            } catch {
              // Ignore edit errors — Telegram rejects edits if content unchanged
            }
          },
          {
            onToolStart,
            channel: "telegram",
            modelOverride,
            onAutoCompactionStart: () => {
              bot.api
                .sendMessage(chatId, "🗜️ Auto\\-compacting context…", {
                  parse_mode: "MarkdownV2",
                  ...(threadId ? { message_thread_id: threadId } : {}),
                })
                .catch(() => {});
            },
            onAutoCompactionEnd: (result) => {
              if (result.success && result.tokensBefore) {
                const beforeK = (result.tokensBefore / 1000).toFixed(1);
                const note = result.willRetry ? " Retrying your request…" : "";
                bot.api
                  .sendMessage(
                    chatId,
                    `✅ Context auto-compacted (~${beforeK}k tokens).${note}`,
                    { ...(threadId ? { message_thread_id: threadId } : {}) }
                  )
                  .catch(() => {});
              }
              // Silent on failure — the next message will naturally fail/retry
            },
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

        // Final step: send the complete response formatted as MarkdownV2, split if needed.
        // If a partial streaming message already exists, edit it with the first chunk
        // (switching from plain-text preview to formatted MarkdownV2 final answer),
        // then send any remaining chunks as new messages.
        const finalV2 = markdownToTelegramV2(response || "(empty response)");
        const finalChunks = splitMessage(finalV2, 4096);
        if (sentMessageId !== null) {
          try {
            await bot.api.editMessageText(chatId, sentMessageId, finalChunks[0], {
              parse_mode: "MarkdownV2",
            });
          } catch {
            // Edit failed (e.g. content unchanged or message deleted) — send as new message
            await bot.api.sendMessage(chatId, finalChunks[0], {
              parse_mode: "MarkdownV2",
              ...(threadId ? { message_thread_id: threadId } : {}),
            });
          }
          for (const chunk of finalChunks.slice(1)) {
            await bot.api.sendMessage(chatId, chunk, {
              parse_mode: "MarkdownV2",
              ...(threadId ? { message_thread_id: threadId } : {}),
            });
          }
        } else {
          await sendLongMessageTo(chatId, threadId, response);
        }
      } else {
        // Non-streaming mode: wait for full response then send
        const response = await ctx.prompt(sessionKey, agentName, text, {
          onToolStart,
          channel: "telegram",
          modelOverride,
          onAutoCompactionStart: () => {
            bot.api
              .sendMessage(chatId, "🗜️ Auto\\-compacting context…", {
                parse_mode: "MarkdownV2",
                ...(threadId ? { message_thread_id: threadId } : {}),
              })
              .catch(() => {});
          },
          onAutoCompactionEnd: (result) => {
            if (result.success && result.tokensBefore) {
              const beforeK = (result.tokensBefore / 1000).toFixed(1);
              const note = result.willRetry ? " Retrying your request…" : "";
              bot.api
                .sendMessage(
                  chatId,
                  `✅ Context auto-compacted (~${beforeK}k tokens).${note}`,
                  { ...(threadId ? { message_thread_id: threadId } : {}) }
                )
                .catch(() => {});
            }
          },
        });
        await sendLongMessageTo(chatId, threadId, response);
      }

      // 🎉 = "LLM finished, no more actions coming"
      setReaction(chatId, userMessageId, "🎉");
    } catch (err) {
      const errorTag = getErrorTag(err);
      ctx.log.error(`[${errorTag}] Session error [${sessionKey}]: ${err}`);

      // 😢 = "processing failed"
      setReaction(chatId, userMessageId, "😢");

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
    const v2 = markdownToTelegramV2(text || "(empty response)");
    const chunks = splitMessage(v2, 4096);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "MarkdownV2",
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
        "<b>Commands</b>\n" +
        "/new — Start a new conversation session\n" +
        "/stop — Abort the current operation immediately\n" +
        "/compact — Summarise and compress conversation history\n" +
        "/status — Show current session info and settings\n" +
        "/agent &lt;name&gt; — Switch agent (history preserved)\n" +
        "/model provider/modelId — Switch model (history preserved)\n" +
        "/verbose on|off — Toggle tool-call notifications\n" +
        "/v on|off — Same as /verbose (shorthand)\n" +
        "/streaming on|off — Toggle real-time response streaming\n" +
        "/s on|off — Same as /streaming (shorthand)\n\n" +
        "<b>Tips</b>\n" +
        "• Send a message while the agent is running to steer it mid-task\n" +
        "• Multiple threads run as independent sessions in parallel\n\n" +
        `<b>Current settings</b>\n` +
        `• Verbose: ${verbose ? "🔊 on" : "🔇 off"}\n` +
        `• Streaming: ${streaming ? "⚡ on" : "📦 off"}`,
      { parse_mode: "HTML" }
    );
  });

  // /new command
  bot.command("new", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(grammyCtx.from!.id, sessionKey);

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

  // /compact command — manually compact the session context
  bot.command("compact", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);

    const progressMsg = await grammyCtx.reply("🗜️ Compacting conversation history…");

    try {
      const { tokensBefore } = await ctx.compactSession(sessionKey);

      // Show post-compaction context so the user sees the result immediately
      const modelRef = ctx.getSessionModel(sessionKey);
      const usage = ctx.getSessionUsage(sessionKey);

      let contextLine = "";
      if (modelRef && usage) {
        const modelInfo = ctx.getModel(modelRef.provider, modelRef.modelId);
        if (modelInfo) {
          const pct = ((usage.inputTokens / modelInfo.contextWindow) * 100).toFixed(1);
          const nowK = (usage.inputTokens / 1000).toFixed(1);
          const maxK = (modelInfo.contextWindow / 1000).toFixed(0);
          const bar = contextBar(usage.inputTokens, modelInfo.contextWindow);
          contextLine = `\n\n<b>Context now:</b> ${bar} ${nowK}k / ${maxK}k (${pct}%)`;
        }
      }

      const beforeK = (tokensBefore / 1000).toFixed(1);
      await grammyCtx.api.editMessageText(
        chatId,
        progressMsg.message_id,
        `✅ <b>Compacted!</b> Previous context: ~${beforeK}k tokens.${contextLine}`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await grammyCtx.api
        .editMessageText(chatId, progressMsg.message_id, `❌ Compaction failed: ${msg}`)
        .catch(() => grammyCtx.reply(`❌ Compaction failed: ${msg}`));
    }

    ctx.log.info(`Manual compaction for session ${sessionKey}`);
  });

  // /status command
  bot.command("status", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(grammyCtx.from!.id, sessionKey);
    const verbose = getVerbose(sessionKey);
    const streaming = getStreaming(sessionKey);

    // ── Model & context usage ──────────────────────────────
    // Read model and usage directly from the session file — model_change entries
    // are written by pi and are always present; session metadata _model is not.
    const modelRef = ctx.getSessionModel(sessionKey);
    const usage = ctx.getSessionUsage(sessionKey);

    let modelLine = "<i>(no session yet)</i>";
    let contextLine = "<i>(no data yet)</i>";

    if (modelRef) {
      const modelInfo = ctx.getModel(modelRef.provider, modelRef.modelId);
      modelLine = modelInfo
        ? `<code>${escapeHtml(modelInfo.name)}</code>`
        : `<code>${escapeHtml(`${modelRef.provider}/${modelRef.modelId}`)}</code>`;

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
      `<b>Session Status</b>\n\n` +
        `Session ID: <code>${escapeHtml(sessionKey)}</code>\n` +
        `Agent: <code>${escapeHtml(agentName)}</code>\n` +
        `Chat: <code>${chatId}${threadId ? ` / Thread: ${threadId}` : ""}</code>\n` +
        `Model: ${modelLine}\n\n` +
        `<b>Context</b>\n` +
        `${contextLine}\n\n` +
        `<b>Settings</b>\n` +
        `• Verbose: ${verbose ? "🔊 on" : "🔇 off"}\n` +
        `• Streaming: ${streaming ? "⚡ on" : "📦 off"}`,
      { parse_mode: "HTML" }
    );
  });

  // /agent command — switch the agent for the current session (preserves history)
  bot.command("agent", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);

    const parts = (grammyCtx.message?.text ?? "").trim().split(/\s+/);
    const newAgent = parts[1];

    // No argument — list available agents
    if (!newAgent) {
      const current = resolveAgent(grammyCtx.from!.id, sessionKey);
      const available = ctx.agentNames.map((n) =>
        n === current ? `• <b>${escapeHtml(n)}</b> ← current` : `• ${escapeHtml(n)}`
      ).join("\n");
      await grammyCtx.reply(
        `<b>Available agents</b>\n\n${available}\n\nUsage: /agent &lt;name&gt;`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (!ctx.agentNames.includes(newAgent)) {
      const list = ctx.agentNames.map((n) => `• ${escapeHtml(n)}`).join("\n");
      await grammyCtx.reply(
        `❌ Unknown agent: <code>${escapeHtml(newAgent)}</code>\n\nAvailable:\n${list}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const prevAgent = resolveAgent(grammyCtx.from!.id, sessionKey);
    if (newAgent === prevAgent) {
      await grammyCtx.reply(
        `Already using agent <code>${escapeHtml(newAgent)}</code>.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Persist the override in session metadata then dispose the in-memory session.
    // The next prompt() call passes newAgent as agentName, so getOrCreateSession
    // will recreate the pi session under the new agent's config while loading the
    // same .jsonl file — conversation history is preserved.
    const meta =
      (ctx.getSessionMetadata(sessionKey, "telegram_settings") as Record<string, unknown>) ?? {};
    meta.agent = newAgent;
    ctx.setSessionMetadata(sessionKey, "telegram_settings", meta);
    await ctx.abortSession(sessionKey);
    await ctx.disposeSession(sessionKey);

    await grammyCtx.reply(
      `✅ Switched to agent <code>${escapeHtml(newAgent)}</code>. ` +
        `Conversation history is preserved. ` +
        `Tools and system prompt now use the new agent's config.`,
      { parse_mode: "HTML" }
    );
    ctx.log.info(`Agent switched ${prevAgent} → ${newAgent} for session ${sessionKey}`);
  });

  // /model command — switch the LLM model for the current session (preserves history)
  bot.command("model", async (grammyCtx) => {
    const chatId = grammyCtx.chat.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(grammyCtx.from!.id, sessionKey);

    const parts = (grammyCtx.message?.text ?? "").trim().split(/\s+/);
    const modelArg = parts[1]; // expected: "provider/modelId"

    // No argument — show current model and allowed models for this agent
    if (!modelArg) {
      const currentModel = ctx.getSessionModel(sessionKey);
      const agentCfg = (ctx.config as any).agents?.[agentName];
      const primary = agentCfg?.model;
      const fallbacks: Array<{ provider: string; model: string }> = agentCfg?.fallbackModels ?? [];

      const modelLine = (m: { provider: string; model: string }): string => {
        const key = `${m.provider}/${m.model}`;
        const isCurrent =
          currentModel?.provider === m.provider && currentModel?.modelId === m.model;
        return isCurrent
          ? `• <b>${escapeHtml(key)}</b> ← current`
          : `• ${escapeHtml(key)}`;
      };

      const lines = [
        ...(primary ? [modelLine(primary)] : []),
        ...fallbacks.map(modelLine),
      ].join("\n") || "<i>(no models configured)</i>";

      await grammyCtx.reply(
        `<b>Available models for <code>${escapeHtml(agentName)}</code></b>\n\n` +
          `${lines}\n\nUsage: /model provider/modelId`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Parse "provider/modelId"
    const slashIdx = modelArg.indexOf("/");
    if (slashIdx === -1) {
      await grammyCtx.reply(
        `❌ Expected format: <code>provider/modelId</code>\nExample: <code>anthropic/claude-sonnet-4-5</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    const provider = modelArg.slice(0, slashIdx);
    const modelId = modelArg.slice(slashIdx + 1);

    // Validate the model exists in the registry before committing
    const modelInfo = ctx.getModel(provider, modelId);
    if (!modelInfo) {
      await grammyCtx.reply(
        `❌ Unknown model: <code>${escapeHtml(modelArg)}</code>\n` +
          `Use /model to list the allowed models for this agent.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Persist the override in session metadata.
    // runSession reads it back and passes it as modelOverride to prompt/promptStreaming,
    // which causes getOrCreateSessionWithModel to recreate the pi session with this
    // model while loading the same .jsonl file — history is preserved.
    const meta =
      (ctx.getSessionMetadata(sessionKey, "telegram_settings") as Record<string, unknown>) ?? {};
    meta.modelOverride = { provider, model: modelId };
    ctx.setSessionMetadata(sessionKey, "telegram_settings", meta);

    const displayName = escapeHtml(modelInfo.name);
    const ctxLine = ` <i>(${(modelInfo.contextWindow / 1000).toFixed(0)}k context)</i>`;
    await grammyCtx.reply(
      `✅ Switched to <b>${displayName}</b>${ctxLine}. Conversation history is preserved.`,
      { parse_mode: "HTML" }
    );
    ctx.log.info(`Model override set to ${provider}/${modelId} for session ${sessionKey}`);
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
        ? "🔊 Verbose mode <b>on</b> — you'll see tool calls as they happen."
        : "🔇 Verbose mode <b>off</b> — tool calls are hidden.",
      { parse_mode: "HTML" }
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
        ? "⚡ Streaming mode <b>on</b> — responses will appear in real-time."
        : "📦 Streaming mode <b>off</b> — full response will be sent once complete.",
      { parse_mode: "HTML" }
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
    const messageId = grammyCtx.message.message_id;
    const userId = grammyCtx.from.id;

    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(userId, sessionKey);

    ctx.log.info(
      `User ${userId} → agent '${agentName}' ` +
        `(chat:${chatId}${threadId ? `/thread:${threadId}` : ""}): ` +
        `${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`
    );

    // 👀 = "received, being processed" — set immediately on every user message
    setReaction(chatId, messageId, "👀");

    // If a session is already running, steer it with the new message.
    // Steering messages don't own the session lifecycle so they don't get ✅/❌.
    if (isActive(sessionKey)) {
      ctx.log.info(`Steering active session: ${sessionKey}`);
      await ctx.steerSession(sessionKey, text);
      return;
    }

    // Mark as pending immediately — before any await — so the next incoming
    // message sees this session as active even before inflightCount is set.
    pendingSessions.add(sessionKey);

    // Give immediate typing feedback, then fire-and-forget the session.
    // runSession owns the 👀→✅/❌ lifecycle for this message.
    await grammyCtx.replyWithChatAction("typing").catch(() => {});

    runSession(chatId, threadId, sessionKey, agentName, text, messageId)
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
          { command: "compact", description: "Summarise and compress conversation history" },
          { command: "status", description: "Show current session info and settings" },
          { command: "agent", description: "Switch agent: /agent <name> (history preserved)" },
          { command: "model", description: "Switch model: /model provider/modelId (history preserved)" },
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
 * Escape the three characters that are special in Telegram HTML mode.
 * Used only for hand-crafted bot command messages (status, compact, etc.).
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape all characters that have special meaning in Telegram MarkdownV2 outside entities.
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeV2(s: string): string {
  // eslint-disable-next-line no-useless-escape
  return s.replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, "\\$&");
}

/**
 * Escape characters that must be escaped inside MarkdownV2 code spans and blocks.
 * Inside code, only backtick and backslash need escaping.
 */
function escapeV2Code(s: string): string {
  return s.replace(/[`\\]/g, "\\$&");
}

/**
 * Convert LLM Markdown output to Telegram MarkdownV2.
 *
 * Why MarkdownV2 instead of HTML:
 *   HTML requires correct nesting of every tag pair. Any ambiguous or overlapping
 *   bold/italic from the LLM (e.g. *italic **bold** italic*) produces mismatched
 *   tags that Telegram rejects, silently dropping the whole message.
 *   MarkdownV2 is the same syntax the LLM already emits — the converter's only
 *   real job is to escape special characters in plain text so Telegram doesn't
 *   misinterpret them as formatting markers.
 *
 * Strategy:
 *  1. Extract fenced code blocks, inline code, and links as opaque placeholders
 *     (each gets its own escaping rules).
 *  2. Escape ALL remaining text with MarkdownV2 escaping — safe baseline, any
 *     un-handled edge case stays as literal text, never a broken entity.
 *  3. Selectively un-escape the formatting markers we want to restore
 *     (bold, italic, strikethrough, headings, blockquotes).
 *  4. Restore placeholders.
 */
export function markdownToTelegramV2(text: string): string {
  const placeholders: string[] = [];
  const save = (s: string): string => {
    placeholders.push(s);
    return `\x00P${placeholders.length - 1}\x00`;
  };

  // ── Step 1a: extract fenced code blocks ─────────────────────────────────
  let result = text.replace(
    /```(\w*)\r?\n?([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const safe = escapeV2Code(code.replace(/\n$/, "")); // trim one trailing newline
      return save(
        lang.trim() ? `\`\`\`${lang.trim()}\n${safe}\n\`\`\`` : `\`\`\`\n${safe}\n\`\`\``
      );
    }
  );

  // ── Step 1b: extract inline code ────────────────────────────────────────
  result = result.replace(
    /`([^`\n]+)`/g,
    (_m, code: string) => save(`\`${escapeV2Code(code)}\``)
  );

  // ── Step 1c: extract links (before general escaping to preserve URLs) ───
  // Inside a MarkdownV2 link URL only ) and \ need escaping.
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, linkText: string, url: string) =>
      save(`[${escapeV2(linkText)}](${url.replace(/[)\\]/g, "\\$&")})`)
  );

  // ── Step 2: escape ALL remaining text ───────────────────────────────────
  result = escapeV2(result);
  // Placeholders contain \x00 which is not a V2 special char → survive escaping.

  // ── Step 3: restore formatting (order: bold before italic) ──────────────
  //
  // After escapeV2, original `**bold**` becomes `\*\*bold\*\*` in the string.
  // We match the escaped form and strip the backslashes to restore the markers.
  // Any case we miss stays as literal escaped text — never a broken entity.

  // Bold ***text*** (bold+italic, rare but valid)
  result = result.replace(/\\\*\\\*\\\*(.+?)\\\*\\\*\\\*/g, "***$1***");

  // Bold **text**
  result = result.replace(/\\\*\\\*(.+?)\\\*\\\*/g, "**$1**");

  // Bold __text__ (LLMs sometimes use this for bold; V2 treats __ as underline,
  // but bold is the intent so we convert to **)
  result = result.replace(/\\_\\_(.+?)\\_\\_/g, "**$1**");

  // Italic *text* — don't match if adjacent to a * that was already restored
  result = result.replace(/(?<!\*)\\\*(?!\*)(.+?)(?<!\*)\\\*(?!\*)/g, "*$1*");

  // Italic _text_ — only at word boundaries (avoids snake_case false positives)
  result = result.replace(/(?<![a-zA-Z0-9])\\_([^_\n]+?)\\_(?![a-zA-Z0-9])/g, "_$1_");

  // Strikethrough: LLM emits ~~text~~; V2 uses ~text~ (single tilde)
  result = result.replace(/\\~\\~(.+?)\\~\\~/g, "~$1~");

  // Headings → bold (MarkdownV2 has no headings)
  result = result.replace(/^\\#{1,6} (.+)$/gm, "**$1**");

  // Horizontal rules → separator (after escaping --- becomes \-\-\-)
  result = result.replace(/^(?:\\-){3,}$|^(?:\\\*){3,}$|^(?:\\_){3,}$/gm, "—————");

  // Blockquotes: `> text` → MarkdownV2 `>text`
  // After escaping, `>` became `\>`.
  result = result.replace(/^\\> ?(.+)$/gm, ">$1");

  // ── Step 4: restore placeholders ────────────────────────────────────────
  result = result.replace(/\x00P(\d+)\x00/g, (_m, i: string) => placeholders[Number(i)]);

  return result;
}

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


