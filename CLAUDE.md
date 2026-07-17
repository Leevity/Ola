# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Electron + Vite with hot reload (primary dev loop).
- `npm run start` — preview the packaged app output (run after `build`).
- `npm run lint` — ESLint with cache. Minimum validation before committing.
- `npm run typecheck` — runs both `typecheck:node` (main/preload, `tsconfig.node.json`) and `typecheck:web` (renderer, `tsconfig.web.json`). Strict TS.
- `npm run format` — Prettier.
- `npm run build` — typecheck then `electron-vite build`.
- `npm run build:unpack` — build + unpacked app for packaging checks.
- `npm run build:{win|mac|linux}` — full packaged installer.
- Docs workspace (separate Next.js + Fumadocs project in `docs/`): `npm --prefix docs run dev|build|types:check`.

There is no root test suite. For UI/IPC/workflow changes, smoke test with `npm run dev`. For packaging changes, run the corresponding `build:*` command.

## Architecture

Four-layer Electron + Node.js app. Keep process boundaries explicit — system access stays in main, UI state stays in renderer, shared types go through `src/shared`.

1. **Electron main (`src/main/`)** — system and orchestration layer. App bootstrap (`index.ts`),
   window lifecycle, IPC handlers (`ipc/`), Native Worker supervision, cron, channels, MCP clients,
   SSH, auto-updates, and crash logging. Its `db/` modules are IPC wrappers rather than the SQLite
   engine.
2. **Preload (`src/preload/`)** — secure bridge exposing a narrow API surface to the renderer. All main↔renderer traffic goes through here; do not add `nodeIntegration` shortcuts.
3. **Renderer (`src/renderer/src/`)** — React 19 UI. Zustand stores (`stores/`), i18n (`locales/`, `react-i18next`, `en`/`zh`), Tailwind v4, Monaco, xterm, recharts. The renderer owns message presentation, approvals, and session UX. `session-runtime-router.ts` buffers message state for background (non-visible) sessions and flushes it when those sessions come to the foreground.
4. **Native Worker runtime (`sidecars/Ola.Native.Worker/`)** — the provider-agnostic Agent loop and
   SQLite owner. Electron main supervises the process and bridges MessagePack streams plus reverse
   tool/approval requests; the renderer remains the interaction surface.

Agent execution runs in `Ola.Native.Worker`. The renderer remains the UI and tool/approval surface;
Electron main is the lifecycle, policy, and transport boundary.

### IPC wiring

The renderer calls main via `ipcClient.invoke(channel, ...args)` (wraps `ipcRenderer.invoke`). Main-process handlers live in `src/main/ipc/*-handlers.ts` — each file registers `ipcMain.handle(channel, ...)` calls. To add a new IPC channel: add the handler in the appropriate `*-handlers.ts`, expose it through `src/preload/index.ts` if it needs a typed `window.api` entry, and declare the type in `src/preload/index.d.ts`. The preload `window.api` object is for operations that need a typed contract (currently team-runtime); most IPC goes through the generic `window.electron.ipcRenderer.invoke(channel)` path.

### Session modes

The app supports multiple session modes: `chat`, `clarify`, `cowork`, `code`, `acp`. Each mode configures different system prompts, tool sets, and UI behavior. Mode is stored per-session in `SessionPromptSnapshot` (see `chat-store.ts`).

### Tool system

Renderer-side tool definitions and handlers live in `src/renderer/src/lib/tools/`. Each tool file exports a handler conforming to `ToolHandler` (see `tool-types.ts`). Tools receive a `ToolContext` with session info, working folder, abort signal, and an IPC client. The main-process agent loop in `cron-agent-background.ts` also executes tools directly for cron/background runs.

Tools are registered in phases via `registerAllTools()` in `src/renderer/src/lib/tools/index.ts`: core tools first, then skills (async), then sub-agents, then teams. Some tools (WebSearch, Browser, Wiki) are registered/unregistered dynamically based on user settings. `ToolContext` carries cross-tool state: `sharedState` (mutable bag for flags like `deliveryUsed`), `readFileHistory` (tracks file reads per run), `inlineToolHandlers` (per-run tool shadowing), and `channelPermissions` (approval checks).

### Channel / messaging plugins

Eight messaging platform integrations under `src/main/channels/providers/`: Feishu, DingTalk, Discord, QQ, Telegram, WeCom, Weixin, WhatsApp. All extend `base-plugin-service.ts`, which defines the abstract contract: subclasses implement `onStart()`, `onStop()`, and messaging methods (`sendMessage`, `replyMessage`, `getGroupMessages`, `listGroups`). The base class handles WebSocket lifecycle and message freshness filtering (15-minute window). Channel manager (`channel-manager.ts`) handles lifecycle; channel descriptors define capabilities.

### Custom skills and agents

Bundled skills live in `resources/skills/` as folders containing a `SKILL.md` metadata file and a `scripts/` subdirectory (typically Python). Bundled agents live in `resources/agents/` as Markdown files with frontmatter (`name`, `description`, `compatibility`). Users can also add custom skills and agents in `~/.ola/skills/` and `~/.ola/agents/` respectively — these are loaded at runtime alongside the bundled ones.

### Agent runtime

The Native Worker Agent Runtime is provider-agnostic. `native-agent-runtime.ts` supervises its
handshake and active runs, while `sidecar-manager.ts` forwards streams and services reverse
requests that require renderer-owned tools or approval state.

### Data and runtime assets

- User data directory: `~/.ola/`. Contains `data.db` (SQLite), plus user-customizable `prompts/` and `agents/` directories loaded at runtime.
- SQLite is opened and migrated by `sidecars/Ola.Native.Worker/Modules/Db/DbSchemaMigrator.cs`.
  `src/main/db/database.ts` requests `db/initialize`; the remaining TypeScript DB modules bridge
  typed calls to Native Worker routes. Schema changes remain additive.
- Bundled runtime assets (shipped to users, loaded at runtime — not source): `resources/agents`, `resources/skills`, `resources/prompts`, `resources/commands`.

`src/shared/` holds cross-process TypeScript contracts. `src/components`, `src/hooks`, `src/lib` at the repo root (not under `renderer/`) are additional shared utilities.

Generated/ignored: `dist/`, `out/`, `build/`, `node_modules/`. Do not edit.

### Native modules

`better-sqlite3`, `@jitsi/robotjs`, `ssh2`, and `node-pty` are native addons rebuilt by `npm run postinstall` (via `scripts/postinstall.mjs`) for the installed Electron version. On Windows, `node-pty` is skipped during rebuild. They are `asarUnpack`'d in `electron-builder.yml` so they load outside the asar archive. `cpu-features` is overridden to a noop (`package.json` overrides).

### Path aliases

Renderer code uses `@renderer/*` → `src/renderer/src/*` (configured in `tsconfig.web.json` and `electron.vite.config.ts`).

### i18n

`react-i18next` with namespaced JSON files under `src/renderer/src/locales/` (`en`/`zh`, split into: common, layout, chat, settings, cowork, agent, ssh). Language is read from `settingsStore.language` at init time — this is static initialization, not reactive. Language changes require an app restart or explicit i18n reload.

## Conventions

- `.editorconfig`: UTF-8, LF, 2 spaces, final newline, trimmed trailing whitespace.
- `.prettierrc.yaml`: single quotes, **no semicolons**, 100-column width, no trailing commas.
- React component files are PascalCase (`Layout.tsx`); stores/helpers/non-component modules are kebab-case (`settings-store.ts`).
- Commit style from history: conventional commits — `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `refactor(scope): ...`, `style(scope): ...`. Keep commits focused; don't mix refactors with behavior changes.
- When bumping the app version in `package.json`, also update the docs homepage version in `docs/src/app/(home)/page.tsx` and keep download links aligned with release assets.
- Never commit local runtime data from `~/.ola/`.
