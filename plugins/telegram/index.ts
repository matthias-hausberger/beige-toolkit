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
 *   workspaceDir:  (optional) Absolute host-side path to the agent workspace.
 *                  When set, incoming media (photos, documents, audio, video,
 *                  voice) are saved to <workspaceDir>/media/inbound/ and the
 *                  agent receives a message with the sandbox-relative path.
 *                  Defaults to <beigeDir>/agents/<defaultAgent>/workspace
 *                  derived from the data directory.
 */

import { Bot, type Context } from "grammy";
import { createWriteStream, mkdirSync } from "fs";
import { join, resolve, basename, isAbsolute, extname } from "path";
import * as https from "https";
import * as http from "http";
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

// Extend the ChannelAdapter interface to include sendPhoto, sendDocument and sendAlbum support
declare module "@matthias-hausberger/beige" {
  interface ChannelAdapter {
    sendPhoto(
      chatId: string,
      threadId: string | undefined,
      photoPath: string,
      caption?: string
    ): Promise<void>;
    sendDocument?(
      chatId: string,
      threadId: string | undefined,
      filePath: string,
      caption?: string
    ): Promise<void>;
    /**
     * Send multiple photos as a Telegram media group (album).
     * Telegram limits each sendMediaGroup call to 2–10 items; larger albums
     * are automatically split into consecutive batches of ≤10.
     *
     * @param photoPaths  Array of paths (workspace-relative, /workspace/…, absolute, or URL)
     * @param caption     Optional caption attached to the first photo of the first batch
     */
    sendAlbum?(
      chatId: string,
      threadId: string | undefined,
      photoPaths: string[],
      caption?: string
    ): Promise<void>;
  }
}
import {
  splitFormattedMessage,
  splitPlainText,
  formatAndSplit,
  escapeV2,
  escapeHtml,
  contextBar,
  formatToolCall,
} from "./format.ts";

// ── Telegram reaction emoji type ─────────────────────────────────────────────
// Subset of the emoji Telegram accepts as message reactions (as of Bot API 7.x).
// The full set is enforced by the API at runtime; this type just documents the
// ones we actually use and prevents passing arbitrary strings.
type TelegramReactionEmoji = "👀" | "😢";

// ── Config types ─────────────────────────────────────────────────────────────

interface TelegramPluginConfig {
  token: string;
  allowedUsers: (number | string)[]; // strings from env vars are coerced to numbers
  agentMapping: { default: string; [userId: number]: string };
  defaults?: {
    verbose?: boolean;
    streaming?: boolean;
  };
  /** Absolute host-side path to the agent workspace (e.g. /home/user/.beige/agents/beige/workspace). */
  workspaceDir?: string;
}

// ── Session settings helpers ─────────────────────────────────────────────────



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

  // ── Workspace / media-inbound helpers ─────────────────────────────────

  /**
   * Resolve the host-side workspace directory.
   * Priority: explicit config.workspaceDir → derived from ctx.dataDir.
   *
   * ctx.dataDir is at <beigeDir>/data/telegram  (two levels above beigeDir).
   * The default agent workspace lives at <beigeDir>/agents/<agentName>/workspace.
   */
  function resolveWorkspaceDir(): string {
    if (cfg.workspaceDir) return cfg.workspaceDir;
    // dataDir = <beigeDir>/data/telegram → go up two levels to get beigeDir
    const beigeHome = resolve(ctx.dataDir, "../..");
    const defaultAgent = cfg.agentMapping.default;
    return join(beigeHome, "agents", defaultAgent, "workspace");
  }

  /**
   * Resolve a file path (from an agent tool call) to an absolute host path.
   *
   * Agents running inside a sandbox see their workspace mounted at /workspace.
   * The gateway passes the real host-side root via config.workspaceDir (or the
   * derived beigeDir path).  Three cases are handled:
   *
   *   1. /workspace/...  →  <workspaceDir>/...
   *      Strip the sandbox mount prefix and rebase onto the real workspace root.
   *
   *   2. relative path   →  <workspaceDir>/<path>
   *      Resolved against the workspace root (no sub-cwd needed here since tool
   *      calls always use workspace-relative paths like "media/outbound/report.pdf").
   *
   *   3. absolute path (not /workspace) → used as-is
   *      Already a real host path (e.g. when called directly from the TUI).
   *
   * This mirrors the path resolution logic in the image plugin.
   */
  function resolveFilePath(filePath: string): string {
    const workspaceRoot = resolveWorkspaceDir();
    const sandboxMount = "/workspace";

    // Case 1: agent sandbox /workspace prefix — strip and rebase onto host root
    if (filePath.startsWith(sandboxMount + "/") || filePath === sandboxMount) {
      const rel = filePath.slice(sandboxMount.length).replace(/^\//, "");
      return join(workspaceRoot, rel);
    }

    // Case 2: relative path — resolve against workspace root
    if (!isAbsolute(filePath)) {
      return join(workspaceRoot, filePath);
    }

    // Case 3: absolute non-/workspace path — already a host path, use as-is
    return filePath;
  }

  /**
   * Download a Telegram file to <workspaceDir>/media/inbound/ and return
   * the sandbox-relative path (media/inbound/<filename>).
   *
   * @param fileId   Telegram file_id
   * @param filename Desired filename (with extension)
   */
  async function downloadMediaToInbound(fileId: string, filename: string): Promise<string> {
    // 1. Ask Telegram for the download URL
    const fileInfo = await bot.api.getFile(fileId);
    const filePath = fileInfo.file_path;
    if (!filePath) {
      throw new Error(`Telegram returned no file_path for file_id: ${fileId}`);
    }
    const downloadUrl = `https://api.telegram.org/file/bot${cfg.token}/${filePath}`;

    // 2. Ensure the inbound directory exists on the host
    const workspaceDir = resolveWorkspaceDir();
    const inboundDir = join(workspaceDir, "media", "inbound");
    mkdirSync(inboundDir, { recursive: true });

    // 3. Stream the file to disk
    const destPath = join(inboundDir, filename);
    await new Promise<void>((resolve, reject) => {
      const file = createWriteStream(destPath);
      const proto: typeof https | typeof http = downloadUrl.startsWith("https") ? https : http;
      proto.get(downloadUrl, (res) => {
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (err) => { file.close(); reject(err); });
        res.on("error", reject);
      }).on("error", reject);
    });

    // 4. Return sandbox-relative path
    return `media/inbound/${filename}`;
  }

  /**
   * Build a unique filename for an incoming media file.
   * Format: <type>-<timestamp>.<ext>
   */
  function mediaFilename(type: string, ext: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    return `${type}-${ts}.${ext}`;
  }

  /**
   * Guess the file extension from a MIME type string.
   */
  function extFromMime(mimeType: string | undefined, fallback: string): string {
    if (!mimeType) return fallback;
    const map: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/mpeg": "mpeg",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "application/pdf": "pdf",
      "text/plain": "txt",
    };
    return map[mimeType] ?? fallback;
  }

  const bot = new Bot(cfg.token);

  // ── Global error boundary ──────────────────────────────────────────────
  // Catches any error that bubbles out of grammY middleware (e.g. failed API
  // calls, unexpected exceptions). Without this, such errors become unhandled
  // rejections that crash the entire process.
  bot.catch((err) => {
    const errorDetail = err.error instanceof Error ? err.error.message : String(err.error);
    ctx.log.error(`GrammY error boundary caught: ${errorDetail}`);

    // Best-effort: notify the user that something went wrong.
    // This may itself fail (e.g. TOPIC_CLOSED) — that's fine, we just log it.
    const chatId = err.ctx?.chat?.id;
    if (chatId) {
      const threadId = err.ctx?.message?.message_thread_id;
      bot.api
        .sendMessage(chatId, `⚠️ An error occurred: ${errorDetail.slice(0, 3000)}`, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        })
        .catch((sendErr) => {
          ctx.log.warn(`Failed to send error notification: ${sendErr}`);
        });
    }
  });

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
    // SessionSettingsStore override takes priority, then channel config default, then system default.
    const override = ctx.getSessionSettings(sessionKey).verbose;
    if (typeof override === "boolean") return override;
    if (typeof cfg.defaults?.verbose === "boolean") return cfg.defaults.verbose;
    return false;
  }

  function getStreaming(sessionKey: string): boolean {
    // SessionSettingsStore override takes priority, then channel config default, then system default.
    const override = ctx.getSessionSettings(sessionKey).streaming;
    if (typeof override === "boolean") return override;
    if (typeof cfg.defaults?.streaming === "boolean") return cfg.defaults.streaming;
    return true;
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

  function setSetting(sessionKey: string, key: "verbose" | "streaming", value: boolean): void {
    // Use SessionSettingsStore via updateSessionSettings — this works even before
    // the first message is sent (no session map entry required), unlike setSessionMetadata
    // which silently drops writes when no entry exists yet.
    ctx.updateSessionSettings(sessionKey, { [key]: value });
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

  /**
   * Remove all reactions from a user's message.
   * Used on successful completion to clear the 👀 "processing" reaction,
   * leaving the message with no reaction at all.
   * Silently ignores failures.
   */
  function clearReaction(chatId: number, messageId: number): void {
    bot.api
      .setMessageReaction(chatId, messageId, [])
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

    // Hoisted so the catch block can delete the "⏳ Processing…" placeholder
    // on error — without this, a failed/timed-out request leaves the placeholder
    // stuck in chat with no explanation.
    let processingMsgId: number | null = null;

    try {
      // Typing indicator — immediate feedback
      await bot.api.sendChatAction(chatId, "typing", {
        ...(threadId ? { message_thread_id: threadId } : {}),
      }).catch(() => {}); // non-fatal if it fails

      if (streaming) {
        // Streaming mode — two-message pattern to avoid spam push notifications:
        //
        //  1. "Processing…" message (Message 1) sent immediately so the user gets
        //     instant feedback.  All intermediate delta updates are applied as
        //     *edits* to this message — edits are silent (no push notifications).
        //
        //  2. When streaming is fully complete, the final formatted response is
        //     sent as a *new* Message 2.  This triggers exactly ONE push notification
        //     for the final answer.
        //
        //  3. Message 1 is then deleted, leaving only the clean final answer.
        //
        // onAssistantTurnStart fires each time the LLM starts a new turn (e.g.
        // after a tool call). We reset the live accumulator so Message 1 always
        // shows the *current* turn's output, not a concatenation of all turns.

        // ── Step 1: send the "Processing" placeholder immediately ──────────
        try {
          const sent = await bot.api.sendMessage(
            chatId,
            "⏳ Processing…",
            { ...(threadId ? { message_thread_id: threadId } : {}) }
          );
          processingMsgId = sent.message_id;
        } catch (err) {
          ctx.log.warn(`Failed to send processing placeholder: ${err}`);
          // Non-fatal — we can continue without the placeholder
        }

        // ── Step 2: stream and silently edit Message 1 ────────────────────
        let currentMessage = "";
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

            if (processingMsgId === null) return; // nothing to edit

            // Edit Message 1 silently — no new push notifications.
            // Show the most recent 4096 chars when content overflows.
            const preview = currentMessage.length <= 4096
              ? currentMessage
              : "…" + currentMessage.slice(-(4096 - 1));
            try {
              await bot.api.editMessageText(chatId, processingMsgId, preview);
            } catch {
              // Telegram rejects edits when content is unchanged — safe to ignore
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
              // New LLM turn starting (e.g. after a tool call) — reset the live
              // accumulator so Message 1 shows only the current turn's output.
              // We do NOT delete/recreate Message 1 here: that would fire a new
              // push notification for every intermediate turn.
              currentMessage = "";
              lastUpdateTime = 0;
            },
          }
        );

        // ── Step 3: send the final formatted response as Message 2 ─────────
        // This triggers exactly one push notification (the new message).
        // After it's sent we delete Message 1 so only the final answer remains.

        // Log empty streaming responses for debugging
        if (!response || response.trim().length === 0) {
          const modelRef = ctx.getSessionModel(sessionKey);
          const usage = ctx.getSessionUsage(sessionKey);
          ctx.log.warn(
            `[empty-response-streaming] Detected for chat:${chatId}` +
            `${threadId ? `/thread:${threadId}` : ""}` +
            ` | session:${sessionKey}` +
            ` | model:${modelRef ? `${modelRef.provider}/${modelRef.modelId}` : "unknown"}` +
            ` | tokens:${usage ? usage.inputTokens : "unknown"}`
          );
        }

        await sendLongMessageTo(chatId, threadId, response);

        // ── Step 4: delete the Processing placeholder ──────────────────────
        if (processingMsgId !== null) {
          bot.api.deleteMessage(chatId, processingMsgId).catch(() => {});
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

      // Clear the 👀 reaction — response delivered, no further indicator needed
      clearReaction(chatId, userMessageId);
    } catch (err) {
      const errorTag = getErrorTag(err);
      const errorDetail = err instanceof Error ? err.message : String(err);
      ctx.log.error(`[${errorTag}] Session error [${sessionKey}]: ${err}`);

      // 😢 = "processing failed"
      setReaction(chatId, userMessageId, "😢");

      // Delete the "⏳ Processing…" placeholder so the user isn't left staring
      // at a stuck message with no context — the error message below replaces it.
      if (processingMsgId !== null) {
        bot.api.deleteMessage(chatId, processingMsgId).catch(() => {});
        processingMsgId = null;
      }

      let errorMessage: string;
      if (isAllModelsExhausted(err)) {
        errorMessage = formatAllModelsExhaustedError(err);
      } else {
        errorMessage = formatChannelError(err, false);
      }

      // Always include the error tag and raw detail so the user sees what went wrong,
      // not just a generic "something went wrong" — especially for UNKNOWN errors
      // that were previously only visible in gateway.log.
      const fullError = `⚠️ [${errorTag}] ${errorMessage}\n\nDetail: ${errorDetail}`;

      try {
        await bot.api.sendMessage(chatId, fullError, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      } catch (sendErr) {
        // If even the error message fails to send, try a minimal version
        ctx.log.warn(`Failed to send error message to Telegram: ${sendErr}`);
        await bot.api
          .sendMessage(chatId, `⚠️ [${errorTag}] Error: ${errorDetail.slice(0, 3000)}`, {
            ...(threadId ? { message_thread_id: threadId } : {}),
          })
          .catch((finalErr) => {
            ctx.log.error(`Failed to send ANY error message to Telegram: ${finalErr}`);
          });
      }
    }
  }

  // ── Bot-level sendLongMessage (no grammyCtx needed) ─────────────────────

  async function sendLongMessageTo(
    chatId: number,
    threadId: number | undefined,
    text: string
  ): Promise<void> {
    // Log empty responses for debugging and pattern analysis
    if (!text || text.trim().length === 0) {
      const sessionKey = telegramSessionKey(chatId, threadId);
      const modelRef = ctx.getSessionModel(sessionKey);
      const usage = ctx.getSessionUsage(sessionKey);
      ctx.log.warn(
        `[empty-response] Detected for chat:${chatId}` +
        `${threadId ? `/thread:${threadId}` : ""}` +
        ` | session:${sessionKey}` +
        ` | model:${modelRef ? `${modelRef.provider}/${modelRef.modelId}` : "unknown"}` +
        ` | tokens:${usage ? usage.inputTokens : "unknown"}`
      );
    }

    const content = text || "(empty response)";
    const threadOpts = threadId ? { message_thread_id: threadId } : {};

    // Try MarkdownV2 first, fall back to plain text if Telegram rejects the formatting.
    // This prevents "can't parse entities" errors from swallowing the entire response.
    try {
      const chunks = formatAndSplit(content, 4096);
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk, {
          parse_mode: "MarkdownV2",
          ...threadOpts,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`MarkdownV2 send failed, falling back to plain text: ${errMsg}`);

      // Send as plain text — guarantee delivery
      const plainChunks = splitPlainText(content, 4096);
      for (const chunk of plainChunks) {
        await bot.api.sendMessage(chatId, chunk, { ...threadOpts });
      }
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
        "/model reset — Clear model override, revert to default\n" +
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

    // Clear session-level setting overrides (both plugin metadata and settings store).
    // clearSessionSettings() uses SessionSettingsStore which works even before
    // the first message — no session entry required.
    ctx.clearSessionSettings(sessionKey);
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

      const beforeK = (tokensBefore / 1000).toFixed(1);
      await grammyCtx.api.editMessageText(
        chatId,
        progressMsg.message_id,
        `✅ <b>Compacted!</b> Previous context: ~${beforeK}k tokens.`,
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

  /**
   * Determine the model selection state for display in /status and /model.
   *
   * Returns:
   * - "default"  — using the agent's primary model, no override
   * - "override" — user explicitly chose this model via /model
   * - "fallback" — automatic fallback (rate limit / error), not user-chosen
   * - undefined  — no session yet
   */
  function getModelState(
    sessionKey: string,
    agentName: string,
    currentModel?: { provider: string; modelId: string }
  ): "default" | "override" | "fallback" | undefined {
    if (!currentModel) return undefined;

    const agentCfg = (ctx.config as any).agents?.[agentName];
    const primary = agentCfg?.model as { provider: string; model: string } | undefined;
    if (!primary) return undefined;

    const isPrimary =
      currentModel.provider === primary.provider &&
      currentModel.modelId === primary.model;

    // Check if there's an explicit user override in session metadata
    const entry = ctx.getSessionEntry(sessionKey);
    const activeModel = entry?.metadata?.activeModel as
      | { provider: string; modelId: string }
      | undefined;

    if (activeModel) {
      return "override";
    }

    return isPrimary ? "default" : "fallback";
  }

  function modelStateLabel(state: "default" | "override" | "fallback" | undefined): string {
    switch (state) {
      case "default":  return " <i>(default)</i>";
      case "override": return " <i>(override — /model reset to revert)</i>";
      case "fallback": return " <i>(fallback — automatic)</i>";
      default:         return "";
    }
  }

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
      const state = getModelState(sessionKey, agentName, modelRef);
      const stateTag = modelStateLabel(state);
      modelLine = modelInfo
        ? `<code>${escapeHtml(modelInfo.name)}</code>${stateTag}`
        : `<code>${escapeHtml(`${modelRef.provider}/${modelRef.modelId}`)}</code>${stateTag}`;

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
      const state = currentModel ? getModelState(sessionKey, agentName, currentModel) : undefined;
      const stateTag = state ? ` ${modelStateLabel(state).trim()}` : "";

      const modelLine = (m: { provider: string; model: string }): string => {
        const key = `${m.provider}/${m.model}`;
        const isCurrent =
          currentModel?.provider === m.provider && currentModel?.modelId === m.model;
        return isCurrent
          ? `• <b>${escapeHtml(key)}</b> ← current${stateTag}`
          : `• ${escapeHtml(key)}`;
      };

      const lines = [
        ...(primary ? [modelLine(primary)] : []),
        ...fallbacks.map(modelLine),
      ].join("\n") || "<i>(no models configured)</i>";

      await grammyCtx.reply(
        `<b>Available models for <code>${escapeHtml(agentName)}</code></b>\n\n` +
          `${lines}\n\n` +
          `Usage:\n` +
          `• <code>/model provider/modelId</code> — switch model\n` +
          `• <code>/model reset</code> — clear override, revert to default`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // "reset" subcommand — clear any persisted model override
    if (modelArg.toLowerCase() === "reset") {
      const prevModel = ctx.getSessionModel(sessionKey);

      // Remove the canonical activeModel override from session metadata
      ctx.clearSessionModel(sessionKey);

      // Also remove the plugin-level modelOverride so runSession stops passing it
      const meta =
        (ctx.getSessionMetadata(sessionKey, "telegram_settings") as Record<string, unknown>) ?? {};
      delete meta.modelOverride;
      ctx.setSessionMetadata(sessionKey, "telegram_settings", meta);

      // Dispose the in-memory session so the next prompt creates a fresh one
      // using the agent's configured primary model instead of the old override.
      await ctx.abortSession(sessionKey);
      await ctx.disposeSession(sessionKey);

      // Clear health/cooldown state for the primary model so it's retried fresh
      // instead of being skipped due to stale rate-limit data.
      const agentCfg = (ctx.config as any).agents?.[agentName];
      if (agentCfg?.model) {
        ctx.clearModelHealth(agentCfg.model.provider, agentCfg.model.model);
      }

      const primaryModel = agentCfg?.model
        ? `<code>${escapeHtml(`${agentCfg.model.provider}/${agentCfg.model.model}`)}</code>`
        : "<i>default</i>";
      const prevLine = prevModel
        ? ` (was <code>${escapeHtml(`${prevModel.provider}/${prevModel.modelId}`)}</code>)`
        : "";

      await grammyCtx.reply(
        `✅ Model reset${prevLine}. Next message will use the default model: ${primaryModel} with normal fallback chain.`,
        { parse_mode: "HTML" }
      );
      ctx.log.info(`Model override cleared for session ${sessionKey}`);
      return;
    }

    // Parse "provider/modelId"
    const slashIdx = modelArg.indexOf("/");
    if (slashIdx === -1) {
      await grammyCtx.reply(
        `❌ Expected format: <code>provider/modelId</code>\nExample: <code>anthropic/claude-sonnet-4-5</code>\n\nOr use <code>/model reset</code> to clear any model override.`,
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
    //
    // setSessionMetadata uses sessionStore.updateMetadata which silently drops writes
    // when no session entry exists yet (before the first message). Create a stub entry
    // if needed so the write is not lost.
    if (!ctx.getSessionEntry(sessionKey)) {
      ctx.createSession(sessionKey, agentName);
    }
    const meta =
      (ctx.getSessionMetadata(sessionKey, "telegram_settings") as Record<string, unknown>) ?? {};
    meta.modelOverride = { provider, model: modelId };
    ctx.setSessionMetadata(sessionKey, "telegram_settings", meta);

    // Also write to the canonical activeModel slot so AgentManager restores the
    // correct model on session creation (e.g. after a gateway restart) even when
    // the modelOverride hasn't been read yet from plugin metadata.
    ctx.persistSessionModel(sessionKey, agentName, provider, modelId);

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

  // ── Media message handlers ─────────────────────────────────────────────
  //
  // For each supported media type we:
  //   1. Download the file to <workspaceDir>/media/inbound/
  //   2. Build a text message describing what arrived (sandbox-relative path + caption)
  //   3. Route that text message through the normal runSession() flow
  //
  // This means the LLM sees something like:
  //   "[Image received: media/inbound/photo-2026-03-30_12-00-00.jpg]\nCaption: look at this"
  // and can then read the file using its read/exec tools.

  async function handleMediaMessage(
    grammyCtx: Context,
    fileId: string,
    filename: string,
    mediaLabel: string,
    caption: string | undefined
  ): Promise<void> {
    const chatId = grammyCtx.chat!.id;
    const threadId = grammyCtx.message?.message_thread_id;
    const messageId = grammyCtx.message!.message_id;
    const userId = grammyCtx.from!.id;
    const sessionKey = telegramSessionKey(chatId, threadId);
    const agentName = resolveAgent(userId, sessionKey);

    ctx.log.info(
      `User ${userId} sent ${mediaLabel} → agent '${agentName}' ` +
        `(chat:${chatId}${threadId ? `/thread:${threadId}` : ""})`
    );

    setReaction(chatId, messageId, "👀");

    let sandboxPath: string;
    try {
      sandboxPath = await downloadMediaToInbound(fileId, filename);
    } catch (err) {
      ctx.log.error(`Failed to download media: ${err}`);
      setReaction(chatId, messageId, "😢");
      await bot.api
        .sendMessage(chatId, `❌ Failed to save ${mediaLabel}: ${err instanceof Error ? err.message : err}`, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        })
        .catch(() => {});
      return;
    }

    // Build the message text the agent will receive
    let agentMessage = `[${mediaLabel} sent to chat: ${sandboxPath}]`;
    if (caption?.trim()) {
      agentMessage += `\nCaption: ${caption.trim()}`;
    }

    if (isActive(sessionKey)) {
      ctx.log.info(`Steering active session with media: ${sessionKey}`);
      await ctx.steerSession(sessionKey, agentMessage);
      return;
    }

    pendingSessions.add(sessionKey);
    await grammyCtx.replyWithChatAction("typing").catch(() => {});
    runSession(chatId, threadId, sessionKey, agentName, agentMessage, messageId)
      .catch((err) => ctx.log.error(`Unhandled session error [${sessionKey}]: ${err}`))
      .finally(() => pendingSessions.delete(sessionKey));
  }

  // Photo handler — Telegram compresses photos; pick the largest available size
  bot.on("message:photo", async (grammyCtx) => {
    const photos = grammyCtx.message.photo; // array of PhotoSize, ascending by size
    const photo = photos[photos.length - 1]; // largest
    const filename = mediaFilename("photo", "jpg");
    await handleMediaMessage(grammyCtx, photo.file_id, filename, "Image", grammyCtx.message.caption);
  });

  // Document handler — preserves original filename and type
  bot.on("message:document", async (grammyCtx) => {
    const doc = grammyCtx.message.document;
    // Use original filename if available, otherwise generate one
    const originalName = doc.file_name;
    const ext = originalName
      ? (originalName.includes(".") ? originalName.split(".").pop()! : extFromMime(doc.mime_type, "bin"))
      : extFromMime(doc.mime_type, "bin");
    const safeName = originalName
      ? originalName.replace(/[^a-zA-Z0-9._-]/g, "_")
      : mediaFilename("document", ext);
    // Ensure uniqueness by prepending timestamp if using original name
    const filename = originalName ? `${Date.now()}_${safeName}` : safeName;
    await handleMediaMessage(grammyCtx, doc.file_id, filename, "Document", grammyCtx.message.caption);
  });

  // Video handler
  bot.on("message:video", async (grammyCtx) => {
    const video = grammyCtx.message.video;
    const ext = extFromMime(video.mime_type, "mp4");
    const filename = mediaFilename("video", ext);
    await handleMediaMessage(grammyCtx, video.file_id, filename, "Video", grammyCtx.message.caption);
  });

  // Audio handler (music files)
  bot.on("message:audio", async (grammyCtx) => {
    const audio = grammyCtx.message.audio;
    const ext = extFromMime(audio.mime_type, "mp3");
    const filename = mediaFilename("audio", ext);
    await handleMediaMessage(grammyCtx, audio.file_id, filename, "Audio", grammyCtx.message.caption);
  });

  // Voice handler (voice messages)
  bot.on("message:voice", async (grammyCtx) => {
    const voice = grammyCtx.message.voice;
    const ext = extFromMime(voice.mime_type, "ogg");
    const filename = mediaFilename("voice", ext);
    await handleMediaMessage(grammyCtx, voice.file_id, filename, "Voice message", undefined);
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
      const chunks = options?.parseMode === "markdown"
        ? splitFormattedMessage(text, 4096)
        : splitPlainText(text, 4096);
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

    async sendPhoto(
      chatId: string,
      threadId: string | undefined,
      photoPath: string,
      caption?: string
    ): Promise<void> {
      const threadParams = threadId ? { message_thread_id: parseInt(threadId, 10) } : {};

      if (photoPath.startsWith("http://") || photoPath.startsWith("https://")) {
        // Send photo by URL — grammY accepts URL strings directly
        await bot.api.sendPhoto(chatId, photoPath, {
          caption,
          ...threadParams,
        });
      } else {
        // Resolve /workspace/... and relative paths to real host paths,
        // then wrap in InputFile so grammY uploads the file from disk.
        const resolvedPath = resolveFilePath(photoPath);

        // Guard: Telegram's sendPhoto only accepts raster images (JPEG, PNG, WebP, GIF).
        // SVGs and other vector/text formats cause IMAGE_PROCESS_FAILED at the API level.
        // Detect by reading the first few bytes so we catch files with wrong extensions.
        const { readFileSync } = await import("fs");
        let fileHeader: Buffer;
        try {
          fileHeader = readFileSync(resolvedPath).subarray(0, 8);
        } catch (err) {
          throw new Error(
            `Cannot read photo file at ${resolvedPath}: ${err instanceof Error ? err.message : err}. ` +
            `Check that the file exists and the path is correct (workspace-relative or absolute).`
          );
        }
        const isJpeg = fileHeader[0] === 0xff && fileHeader[1] === 0xd8;
        const isPng  = fileHeader[0] === 0x89 && fileHeader[1] === 0x50 && fileHeader[2] === 0x4e && fileHeader[3] === 0x47;
        const isWebp = fileHeader[0] === 0x52 && fileHeader[1] === 0x49 && fileHeader[2] === 0x46 && fileHeader[3] === 0x46;
        const isGif  = fileHeader[0] === 0x47 && fileHeader[1] === 0x49 && fileHeader[2] === 0x46;
        const looksLikeRaster = isJpeg || isPng || isWebp || isGif;

        if (!looksLikeRaster) {
          const ext = extname(resolvedPath).toLowerCase();
          throw new Error(
            `sendPhoto requires a raster image (JPEG, PNG, WebP, or GIF) but the file ` +
            `"${basename(resolvedPath)}" does not appear to be one (extension: "${ext || "none"}", ` +
            `magic bytes: ${fileHeader.toString("hex").slice(0, 8)}). ` +
            `If this is an SVG or PDF, use sendDocument instead.`
          );
        }

        const { InputFile } = await import("grammy");
        await bot.api.sendPhoto(chatId, new InputFile(resolvedPath), {
          caption,
          ...threadParams,
        });
      }
    },

    async sendDocument(
      chatId: string,
      threadId: string | undefined,
      filePath: string,
      caption?: string
    ): Promise<void> {
      const threadParams = threadId ? { message_thread_id: parseInt(threadId, 10) } : {};

      if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
        // Send document by URL directly — grammY accepts URL strings
        await bot.api.sendDocument(chatId, filePath, {
          caption,
          ...threadParams,
        });
      } else {
        // Resolve /workspace/... and relative paths to real host paths,
        // then wrap in InputFile so grammY uploads the file from disk.
        const resolvedPath = resolveFilePath(filePath);
        const { InputFile } = await import("grammy");
        const filename = basename(resolvedPath);
        await bot.api.sendDocument(chatId, new InputFile(resolvedPath, filename), {
          caption,
          ...threadParams,
        });
      }
    },

    async sendAlbum(
      chatId: string,
      threadId: string | undefined,
      photoPaths: string[],
      caption?: string
    ): Promise<void> {
      if (photoPaths.length === 0) {
        throw new Error("sendAlbum requires at least one photo path");
      }
      if (photoPaths.length === 1) {
        // Single photo — fall through to sendPhoto for proper validation + upload
        await channelAdapter.sendPhoto(chatId, threadId, photoPaths[0], caption);
        return;
      }

      const { InputFile } = await import("grammy");
      const { readFileSync } = await import("fs");
      const threadParams = threadId ? { message_thread_id: parseInt(threadId, 10) } : {};

      // Telegram's sendMediaGroup limit: 2–10 items per call.
      // Split larger albums into consecutive batches; caption goes on first item of first batch only.
      const BATCH_SIZE = 10;

      /**
       * Resolve a single photo path and validate it is a raster image.
       * Returns an InputFile (local) or a URL string (remote).
       */
      async function resolvePhotoInput(photoPath: string): Promise<{ type: "url"; url: string } | { type: "file"; file: InstanceType<typeof InputFile>; resolvedPath: string }> {
        if (photoPath.startsWith("http://") || photoPath.startsWith("https://")) {
          return { type: "url", url: photoPath };
        }

        const resolvedPath = resolveFilePath(photoPath);

        // Same magic-bytes raster guard as sendPhoto
        let fileHeader: Buffer;
        try {
          fileHeader = readFileSync(resolvedPath).subarray(0, 8);
        } catch (err) {
          throw new Error(
            `Cannot read photo file at ${resolvedPath}: ${err instanceof Error ? err.message : err}. ` +
            `Check that the file exists and the path is correct (workspace-relative or absolute).`
          );
        }
        const isJpeg = fileHeader[0] === 0xff && fileHeader[1] === 0xd8;
        const isPng  = fileHeader[0] === 0x89 && fileHeader[1] === 0x50 && fileHeader[2] === 0x4e && fileHeader[3] === 0x47;
        const isWebp = fileHeader[0] === 0x52 && fileHeader[1] === 0x49 && fileHeader[2] === 0x46 && fileHeader[3] === 0x46;
        const isGif  = fileHeader[0] === 0x47 && fileHeader[1] === 0x49 && fileHeader[2] === 0x46;

        if (!isJpeg && !isPng && !isWebp && !isGif) {
          const ext = extname(resolvedPath).toLowerCase();
          throw new Error(
            `sendAlbum requires raster images (JPEG, PNG, WebP, or GIF) but "${basename(resolvedPath)}" ` +
            `does not appear to be one (extension: "${ext || "none"}", magic bytes: ${fileHeader.toString("hex").slice(0, 8)}). ` +
            `If this is an SVG or PDF, use sendDocument instead.`
          );
        }

        return { type: "file", file: new InputFile(resolvedPath), resolvedPath };
      }

      // Resolve all paths upfront so any validation errors surface before we start uploading
      const resolved = await Promise.all(photoPaths.map(resolvePhotoInput));

      // Send in batches of up to BATCH_SIZE
      for (let i = 0; i < resolved.length; i += BATCH_SIZE) {
        const batch = resolved.slice(i, i + BATCH_SIZE);
        const isFirstBatch = i === 0;

        // Build the InputMediaPhoto array for this batch.
        // Telegram only accepts the caption on the first item of the first batch.
        const media = batch.map((item, batchIndex): { type: "photo"; media: string | InstanceType<typeof InputFile>; caption?: string } => {
          const isFirstItem = isFirstBatch && batchIndex === 0;
          const mediaSource = item.type === "url" ? item.url : item.file;
          return {
            type: "photo",
            media: mediaSource,
            ...(isFirstItem && caption ? { caption } : {}),
          };
        });

        await bot.api.sendMediaGroup(chatId, media, threadParams);
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
          "  telegram sendMessage  <chatId> <text>\n" +
          "  telegram sendMessage  <chatId> --thread <threadId> <text>\n" +
          "  telegram sendPhoto    <chatId> <photoPath> [caption]\n" +
          "  telegram sendPhoto    <chatId> --thread <threadId> <photoPath> [caption]\n" +
          "  telegram sendDocument <chatId> <filePath> [caption]\n" +
          "  telegram sendDocument <chatId> --thread <threadId> <filePath> [caption]\n" +
          "  telegram sendAlbum    <chatId> <path1> <path2> [... pathN] [--caption <text>]\n" +
          "  telegram sendAlbum    <chatId> --thread <threadId> <path1> <path2> [... pathN] [--caption <text>]",
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

      case "sendPhoto":
      case "send_photo": {
        if (args.length < 3) {
          return {
            output: "Usage: telegram sendPhoto <chatId> <photoPath> [caption]\n       telegram sendPhoto <chatId> --thread <threadId> <photoPath> [caption]",
            exitCode: 1,
          };
        }

        const chatId = args[1];
        let threadId: string | undefined;
        let photoPathIndex = 2;
        let caption: string | undefined;

        // Parse --thread option
        if (args[2] === "--thread" && args.length >= 5) {
          threadId = args[3];
          photoPathIndex = 4;
        }

        const photoPath = args[photoPathIndex];
        if (!photoPath) {
          return { output: "Error: photo path cannot be empty", exitCode: 1 };
        }

        // Extract caption if provided (everything after the photo path)
        if (args.length > photoPathIndex + 1) {
          caption = args.slice(photoPathIndex + 1).join(" ");
        }

        try {
          await channelAdapter.sendPhoto(chatId, threadId, photoPath, caption);
          return {
            output: `Photo sent to chat ${chatId}${threadId ? ` (thread ${threadId})` : ""}`,
            exitCode: 0,
          };
        } catch (err) {
          return {
            output: `Failed to send photo: ${err instanceof Error ? err.message : err}`,
            exitCode: 1,
          };
        }
      }

      case "sendDocument":
      case "send_document": {
        if (args.length < 3) {
          return {
            output:
              "Usage: telegram sendDocument <chatId> <filePath> [caption]\n" +
              "       telegram sendDocument <chatId> --thread <threadId> <filePath> [caption]\n\n" +
              "filePath may be:\n" +
              "  • An absolute path on the host (e.g. /home/user/.beige/agents/beige/workspace/report.pdf)\n" +
              "  • A workspace-relative path     (e.g. media/outbound/report.pdf)\n" +
              "  • A public URL                  (e.g. https://example.com/file.pdf)",
            exitCode: 1,
          };
        }

        const chatId = args[1];
        let threadId: string | undefined;
        let filePathIndex = 2;
        let caption: string | undefined;

        // Parse --thread option
        if (args[2] === "--thread" && args.length >= 5) {
          threadId = args[3];
          filePathIndex = 4;
        }

        const filePath = args[filePathIndex];
        if (!filePath) {
          return { output: "Error: file path cannot be empty", exitCode: 1 };
        }

        // Extract caption if provided (everything after the file path)
        if (args.length > filePathIndex + 1) {
          caption = args.slice(filePathIndex + 1).join(" ");
        }

        try {
          await channelAdapter.sendDocument!(chatId, threadId, filePath, caption);
          return {
            output: `Document sent to chat ${chatId}${threadId ? ` (thread ${threadId})` : ""}`,
            exitCode: 0,
          };
        } catch (err) {
          return {
            output: `Failed to send document: ${err instanceof Error ? err.message : err}`,
            exitCode: 1,
          };
        }
      }

      case "sendAlbum":
      case "send_album": {
        // Usage: telegram sendAlbum <chatId> [--thread <threadId>] <path1> <path2> [...pathN] [--caption <text>]
        //
        // Paths and caption can be interspersed in any order after the chatId/thread params.
        // --caption consumes the rest of the argument list as the caption string so it must
        // come after all paths (or use quotes in the shell).
        const chatId = args[1];
        if (!chatId) {
          return {
            output:
              "Usage: telegram sendAlbum <chatId> <path1> <path2> [... pathN] [--caption <text>]\n" +
              "       telegram sendAlbum <chatId> --thread <threadId> <path1> <path2> [... pathN] [--caption <text>]\n\n" +
              "At least 2 photos are recommended (Telegram groups 2–10 photos per album batch).\n" +
              "Paths may be workspace-relative, /workspace/…, absolute, or public URLs.",
            exitCode: 1,
          };
        }

        let threadId: string | undefined;
        let argStart = 2;

        // Parse optional --thread <threadId>
        if (args[2] === "--thread" && args[3]) {
          threadId = args[3];
          argStart = 4;
        }

        // Collect remaining args, splitting at --caption to extract optional caption
        const remaining = args.slice(argStart);
        let caption: string | undefined;
        const photoPaths: string[] = [];

        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i] === "--caption") {
            // Everything after --caption is the caption string
            caption = remaining.slice(i + 1).join(" ") || undefined;
            break;
          }
          photoPaths.push(remaining[i]);
        }

        if (photoPaths.length === 0) {
          return {
            output: "Error: sendAlbum requires at least one photo path",
            exitCode: 1,
          };
        }

        try {
          await channelAdapter.sendAlbum!(chatId, threadId, photoPaths, caption);
          return {
            output:
              `Album sent to chat ${chatId}${threadId ? ` (thread ${threadId})` : ""}: ` +
              `${photoPaths.length} photo${photoPaths.length === 1 ? "" : "s"}` +
              (photoPaths.length > 10 ? ` (split into ${Math.ceil(photoPaths.length / 10)} batches)` : ""),
            exitCode: 0,
          };
        } catch (err) {
          return {
            output: `Failed to send album: ${err instanceof Error ? err.message : err}`,
            exitCode: 1,
          };
        }
      }

      default:
        return {
          output: `Unknown subcommand: ${subcommand}\nAvailable: sendMessage, sendPhoto, sendDocument, sendAlbum`,
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
          "Send messages, photos, albums, and files (PDFs, documents, etc.) to Telegram chats. Use this to proactively notify users.",
        commands: [
          "sendMessage  <chatId> <text>                                        — Send a message to a chat",
          "sendMessage  <chatId> --thread <id> <text>                          — Send to a specific thread",
          "sendPhoto    <chatId> <photoPath> [caption]                         — Send a single photo",
          "sendPhoto    <chatId> --thread <id> <photoPath> [caption]           — Send photo to thread",
          "sendAlbum    <chatId> <p1> <p2> [...pN] [--caption <text>]          — Send multiple photos as one album (batches of 10)",
          "sendAlbum    <chatId> --thread <id> <p1> <p2> [...pN] [--caption <text>] — Send album to thread",
          "sendDocument <chatId> <filePath> [caption]                          — Send any file (PDF, etc.)",
          "sendDocument <chatId> --thread <id> <filePath> [caption]            — Send file to a specific thread",
        ],
        handler: telegramToolHandler,
      });

      // Subscribe to model switch events so the user is notified when fallback occurs
      reg.hook("modelSwitched", async (event) => {
        // Only notify for Telegram sessions
        if (!event.sessionKey.startsWith("telegram:")) return;

        const parts = event.sessionKey.split(":");
        const chatId = parts[1];
        const threadId = parts[2]; // may be undefined

        const reasonLabels: Record<string, string> = {
          fallback_rate_limit: "⏳ Rate limit on primary model",
          fallback_error: "⚠️ Error on primary model",
          fallback_timeout: "⏰ Primary model timed out",
          user_override: "👤 Manual model switch",
        };
        const reasonText = reasonLabels[event.reason] ?? event.reason;
        const from = `${event.previousModel.provider}/${event.previousModel.modelId}`;
        const to = `${event.newModel.provider}/${event.newModel.modelId}`;

        const message =
          `🔄 <b>Model switched</b>\n\n` +
          `${reasonText}\n` +
          `From: <code>${escapeHtml(from)}</code>\n` +
          `To: <code>${escapeHtml(to)}</code>`;

        try {
          await channelAdapter.sendMessage(chatId, threadId, message, { parseMode: "html" });
        } catch (err) {
          ctx.log.warn(`Failed to send model switch notification: ${err}`);
        }
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
          { command: "model", description: "Switch model: /model provider/modelId or /model reset" },
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

// ── Formatting helpers moved to ./format.ts ──────────────────────────────────

