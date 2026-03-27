# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1-beta5] - 2026-03-26

### Added — Telegram plugin

- **Message reactions** — bot reacts to every incoming user message: 👀 on receipt (processing), 🎉 on successful completion, 😢 on error. Steering messages get 👀 only (they don't own the session lifecycle). Reactions are silently skipped if the chat type or bot permissions don't support them
- **`/stop`** — immediately aborts the current operation; partial response (if any) is sent first
- **`/compact`** — manually compacts conversation history; shows tokens freed and post-compaction context bar; works after gateway restart
- **`/status`** now shows current model name and context window usage bar (`▓▓▓░░░░░░░ 38.5k / 200k (19.3%)`)
- **Concurrent sessions** — multiple threads/chats run simultaneously; the grammY handler is non-blocking (fire-and-forget)
- **Steering** — sending a message while the agent is running steers it mid-task, exactly like ESC in the TUI; no need to wait or stop first
- **Auto-compaction notifications** — bot sends `🗜️ Auto-compacting context…` and `✅ Context auto-compacted (~Xk tokens).` when pi automatically compacts the context
- **LLM error forwarding** — auth failures (401), rate limits, model unavailability, etc. now surface as user-friendly messages instead of `(empty response)`
- **Long message splitting** — responses longer than 4096 characters are split into multiple messages; streaming mode correctly splits the final response rather than truncating it

### Changed — Telegram plugin

- Streaming intermediate updates now show a tail-window (most recent 4096 chars) instead of truncating from the start
- Pre-tool-call text is discarded when the final LLM turn starts; only the last turn's response is shown
- Error messages use the `formatChannelError` / `formatAllModelsExhaustedError` helpers for consistent, user-friendly formatting

### Added — Git plugin

- `sshKeyPath` and `sshKnownHostsPath` can now be configured directly on `auth` to override per-agent defaults

### Changed — Git plugin

- `auth.mode` simplified: `"agent-ssh"` removed; `"ssh"` now covers both the default (per-agent key at `agentDir/ssh/`) and explicit key paths. **Breaking:** configs using `mode: "agent-ssh"` must change to `mode: "ssh"`
