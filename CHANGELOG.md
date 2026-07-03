# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-07-03

First public release of **Ola**, an independent codebase maintained by the Leevity team.

### What is Ola

Ola is a local-first AI desktop workspace. It combines a React 19 renderer, an Electron main process, a secure preload bridge, and a .NET native worker sidecar into one cross-platform agent runtime. The app's purpose is to turn multi-step, multi-application work — file editing, Git, shell, SSH, browser, drawing, scheduling — into natural-language conversations, so the user can say what they want and let the agent execute it.

### Highlights in 1.0.0

**Core runtime**

- Electron 36 + React 19 + TypeScript strict; Vite/electron-vite build pipeline.
- .NET 8 native worker sidecar with Anthropic Messages, OpenAI Chat, OpenAI Responses (incl. WebSocket mode), and Gemini providers.
- MessagePack IPC between the main process and the sidecar, plus a typed `AgentStreamEnvelope` v1 protocol between main and renderer.
- Session-scoped agent state, prompt cache keys scoped by install id + workspace, and stable cache-shape serialization (FNV-1a).
- Concurrency limiter, context compression by `contextLength`, and request-debug store with body redaction.

**UI**

- Per-session model selection (inherit / auto / manual), with `model_selection_mode` column on sessions.
- Streaming tool-call rendering, foreground/background session sync, session change summaries.
- Live SSH process monitor, drawing canvas, source control panel, file-aware editor, transcript export.
- Streaming markdown blocks (fence/math aware), AskUserQuestion flow, Clarify mode with strict "clarify first, then plan".
- Compact right-edge message locator with hover previews for long conversations.
- Localized in zh / en / ja / ko and 9 more languages.

**Integrations**

- Built-in providers: OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot Kimi, MiniMax, Zhipu, Qwen, Ollama, Whalecloud (opt-in preset), and any OpenAI-compatible endpoint.
- Channel plugins: Feishu (Lark), DingTalk, Discord, QQ, and the custom extension system.
- MCP client with auto-connect, SSH/terminal via `ssh2` + `node-pty`, Git integration, WebDAV sync for cross-device state.
- Luckin Coffee extension resources bundled.

**Reliability**

- Native worker restart on `sidecarUnavailable`, request stop, run-id-aware cancellation, circuit-breaker on repeated upstream failures.
- Shell/SSH output forwarded through `shell:output` so terminal and tool cards stay live.
- Crash log and native crash dump directories auto-managed.

### Platform support

- macOS: arm64, x64 (`.dmg` / `.zip`).
- Windows: x64, arm64 (NSIS installer).
- Linux: x64, arm64 (`.AppImage` / `.deb`).

### Notes

- macOS `.dmg` is unsigned in this release (Gatekeeper will prompt on first open — right-click → Open). Apple notarization is planned for a follow-up.
- The release is built end-to-end by GitHub Actions from this `v1.0.0` tag; native worker binaries are bundled per platform at build time.
- The full documentation site lives at **[lbxai.cn](https://lbxai.cn/)**.

### Security

- All renderer → main calls go through `contextBridge` with a narrow, typed API surface.
- IPC channels are explicit allowlists; binary payloads are MessagePack-encoded.
- File-read and image-read byte limits are configurable via `OLA_MAX_FILE_READ_MB` / `OLA_MAX_IMAGE_READ_MB`.
- Provider API keys are stored via the secure key store; nothing in this repository contains real credentials.
