# Ola Project Wiki

Ola is a local-first Electron desktop application for AI-assisted work. It combines
a React renderer, Electron main process, secure preload bridge, and a .NET native
worker sidecar into one desktop agent runtime.

This document is the repository map for the Ola codebase. It describes the current
project as an independent codebase and is intended for maintainers who need to
understand where features live, how the app starts, and what should or should not be
committed.

## Architecture

Ola is organized into four runtime layers:

```text
Renderer (React 19) <-> Preload bridge <-> Electron main <-> Native worker
```

- **Renderer**: React UI, Zustand stores, chat surface, settings, tool approvals,
  model/provider configuration, and agent-facing tool definitions.
- **Preload**: A narrow `contextBridge` surface that exposes safe APIs from the main
  process to the renderer.
- **Main process**: Electron lifecycle, IPC handlers, filesystem/shell/SSH access,
  sync, cron scheduling, channel integrations, MCP clients, and native worker
  orchestration.
- **Native worker**: .NET 10 AOT sidecar for SQLite, filesystem, Git, SSH, settings,
  skills, user content, and provider runtime requests.

## Source Layout

```text
src/
├── main/              Electron main process
│   ├── channels/      Messaging integrations
│   ├── cron/          Scheduled agent runtime
│   ├── db/            DAO wrappers backed by the native worker
│   ├── goals/         Goal runtime state and continuation logic
│   ├── ipc/           Main-process IPC handlers
│   ├── lib/           Main-process helpers
│   ├── mcp/           Model Context Protocol client support
│   ├── migration/     Optional import helpers
│   ├── ssh/           SSH and terminal support
│   └── sync/          WebDAV sync
├── preload/           Secure renderer bridge
├── renderer/src/      React application
│   ├── components/    UI surfaces
│   ├── hooks/         React hooks
│   ├── lib/           Agent loop, tools, API clients, utilities
│   ├── locales/       i18n resources
│   └── stores/        Zustand stores
└── shared/            Cross-process TypeScript contracts

sidecars/Ola.Native.Worker/
├── Modules/           Native worker feature modules
├── Protocol/          MessagePack transport protocol
└── Runtime/           Runtime helpers such as API User-Agent handling

resources/
├── agents/            Built-in agent templates
├── commands/          Built-in slash commands
├── prompts/           Built-in prompts
├── skills/            Bundled skills
└── souls/             Built-in persona/profile resources
```

## Entry Points

- Main process: `src/main/index.ts`
- Preload bridge: `src/preload/index.ts`
- Renderer app: `src/renderer/src/App.tsx`
- Native worker project: `sidecars/Ola.Native.Worker/Ola.Native.Worker.csproj`
- Native worker publish script: `scripts/publish-native-worker.mjs`
- Packaging config: `electron-builder.yml`
- GitHub release workflow: `.github/workflows/build.yml`

## Runtime Data

User data lives outside the repository:

- Data directory: `~/.ola/`
- Database: `~/.ola/data.db`
- Runtime config: `~/.ola/config.json`
- Runtime settings: `~/.ola/settings.json`

Do not commit local runtime data. Repository-local `.agents/`, `.plan/`, and
`.claude/` directories are ignored because they contain local assistant state and
working notes.

## Provider User-Agent

The default API User-Agent is `Ola/{version}`.

The logic is centralized in:

- `src/renderer/src/lib/api/api-user-agent.ts`
- `src/main/lib/api-user-agent.ts`
- `sidecars/Ola.Native.Worker/Runtime/ApiUserAgent.cs`

Provider configuration can override the default with `provider.userAgent`. The
settings UI exposes this field on each provider, which is useful for compatibility
testing against third-party APIs.

## Build Commands

```bash
npm install
npm run native:publish
npm run dev
npm run typecheck
npm run lint
npm run build
```

Platform packaging commands:

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

The GitHub release workflow builds installable artifacts for Windows, macOS, and
Linux when a GitHub Release is published.

## Release Flow

1. Update `package.json` and `package-lock.json` to the release version.
2. Run `npm run typecheck`, `npm run lint -- --quiet`, and `npm run build`.
3. Commit the release changes.
4. Push to GitHub.
5. Create a GitHub Release tag such as `v1.0.0`.
6. Let `.github/workflows/build.yml` build and attach installers.

## Commit Hygiene

Commit source, resources, docs, and build configuration. Do not commit:

- `node_modules/`
- `out/`
- `dist/`
- `resources/native-worker/`
- `~/.ola/`
- `.agents/`
- `.plan/`
- `.claude/`
- `.env` or `.env.*`

Before a public release, scan for product identity regressions using the current
maintainer checklist. Keep the literal legacy brand terms out of committed docs so
the repository remains easy to audit with a zero-hit search.

## Maintenance Notes

- Keep app identity, package metadata, update metadata, User-Agent defaults, and
  docs aligned with Ola.
- Keep schema changes additive. Existing SQLite migrations are applied by the
  native worker.
- Treat upstream projects and third-party services as references only; Ola's
  repository history and release process should remain independent.
- Re-run native worker publishing after changes in `sidecars/Ola.Native.Worker/`.
