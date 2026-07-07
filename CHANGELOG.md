# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] - 2026-07-07

Patch release focused on **Desktop Companions (桌宠)** — a major new feature area that turns Ola into a living workspace buddy, plus several companion UX refinements and platform integrations.

### Highlights

**Desktop Companions (桌宠) — new**

- **First-class companion system.** Companions are now first-class citizens in Ola. Each companion has its own profile, mood, growth, and chat personality, and lives on the desktop as a transparent, draggable sprite that walks, sleeps, begs, bathes, and reacts to what you do.
- **Multi-companion desktop.** Multiple companions can co-exist on the desktop at the same time. Switch the active companion from the system tray, right-click for actions, drag to reposition. Enabled count is capped so the desktop stays calm.
- **Companion editor with four sections.** A redesigned editor dialog with `Overview`, `Skin`, `Agent`, and `Exp` tabs covers name & persona, skin/pose variants, agent brain (model + system prompt), and growth rules — all in one place.
- **AI-powered companion studio.** Generate a new companion from a rough idea: Ola drafts the name, persona, and image prompt, then renders a transparent sprite. You can upload a reference image for character-consistent image-to-image generation; if that fails, Ola falls back to text-to-image and tells you.
- **Standards & poses.** A single growth/pose standard (`PET_MAX_LEVEL = 10`, `PET_POSE_STANDARDS`) defines required/recommended poses per level — `idle`, `walk`, `eat`, `bathe`, `sleep`, `play`, `held` are required; `beg`, `munch`, `soak`, `zen`, `swim` unlock as the companion levels up. Every pose has a fallback so missing art never breaks the experience.
- **Token-aware XP & coin economy.** Normal chat and agent usage silently accrues XP into a **shared resource pool** (`usePetResourcePoolStore`); assign pooled XP to any companion, or convert it into shared coins (`usePetWalletStore`). This decouples "earning" from "spending" and makes companion growth feel fair across models.
- **Companion import/export.** Download the default Aniya config as a starter template, edit poses and metadata, then re-import via the studio. Copy an existing companion as a starting point for a new one.
- **Ambient usage integration.** `recordUsageEvent` now feeds `chat` and `agent` source kinds into `accruePetResourcePoolFromAmbientUsage`, so companions grow alongside real work without any extra action.
- **Legacy-to-default sync layer.** A new `default-pet-sync` module keeps the legacy single-pet store and the new multi-pet store in lockstep, so existing users keep their companion's mood, growth, and XP after upgrading.

**Companion UX refinements**

- Cute `CapybaraSprite` polish for the default companion view.
- `MultiPetDesktopView` and `PetView` rewrites for stable z-order, smoother dragging, and better hit-testing when many companions overlap.
- `PetWindow` simplified — fewer moving parts, easier to maintain.
- `PetListTab` rebuilt with archive/restore, copy-as-template, on/off toggle, and a `setOnDesktop` toast.
- Settings panel: companion pool card shows available XP and one-click "Feed current companion" / "Convert to coins".
- New locale strings (zh / en) for studio errors, pool, copy, growth standards, and reference-image fallback.

**IPC & runtime**

- `pet-handlers` extended to cover import, export, copy, ambient accrual, and pool ↔ wallet conversion, all behind the existing typed IPC boundary.
- MessagePack channel routing adds the new `pet:*` sync events.
- `usage-analytics` records token usage and converts it into companion XP without blocking the analytics write path.

### Changes by area

- **New files**
  - `src/renderer/src/lib/pet/default-pet-sync.ts` — legacy↔default store sync.
  - `src/renderer/src/lib/pet/pet-claim-optimizer.ts` — AI studio's name/persona/prompt optimizer.
  - `src/renderer/src/lib/pet/pet-standards.ts` — growth levels, pose requirements, fallback map.
  - `src/renderer/src/stores/pet-resource-pool-store.ts` — shared XP pool with persist.
  - `src/renderer/src/stores/pet-wallet-store.ts` — shared coin wallet with persist.
- **Rewritten**
  - `src/renderer/src/components/pet/PetView.tsx`, `PetWindow.tsx`, `MultiPetDesktopView.tsx`
  - `src/renderer/src/components/settings/pet/PetListTab.tsx`
  - `src/renderer/src/components/settings/pet/pet-editor/{Overview,Skin,Agent,Exp}Section.tsx`
  - `src/main/ipc/pet-handlers.ts`, `src/main/index.ts` (companion window wiring)
- **Updated**
  - `src/renderer/src/lib/pet/pet-exp.ts`, `pet-migrate.ts`, `usage-analytics.ts`
  - `src/renderer/src/stores/{pet-store,pets-store}.ts`
  - `src/renderer/src/locales/{en,zh}/pet.json`
  - `resources/pets/aniya/pet.json` (rename → `Aniya` for parity with the studio's standard).

### Notes

- The companion system is fully local — all sprites, XP, and coins live in `~/.ola/` and persist across sessions. No companion data leaves your machine.
- Companions are off by default for users upgrading from 1.0.0. Enable one from **Settings → Companions** to bring it onto the desktop.
- macOS `.dmg` remains unsigned in 1.0.1; right-click → Open on first launch. Notarization is planned for a follow-up.

### Platform support

Same matrix as 1.0.0:

- macOS: arm64, x64 (`.dmg` / `.zip`).
- Windows: x64, arm64 (NSIS installer).
- Linux: x64, arm64 (`.AppImage` / `.deb`).

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
