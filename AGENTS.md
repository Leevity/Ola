# Repository Guidelines

## Project Structure & Module Organization

Ola is a 4-layer Electron desktop app (Main → Preload → Renderer → Agent runtime).

```
src/
├── main/              # Electron main process — system access & IPC handlers
│   ├── index.ts       # App bootstrap, window lifecycle, zoom
│   ├── channels/      # Messaging plugins (Feishu, DingTalk, Discord, QQ, etc.)
│   ├── cron/          # Scheduled task agent runtime
│   ├── db/            # BusinessRepository-backed data access
│   ├── ipc/           # IPC handlers (main ↔ renderer bridge)
│   ├── mcp/           # Model Context Protocol client
│   ├── goals/         # Goal/task persistence and lifecycle
│   ├── sync/          # WebDAV sync for cross-device state
│   ├── lib/           # Main-process utilities
│   ├── migration/     # Legacy migration helpers
│   └── ssh/           # SSH/terminal support
├── preload/           # Secure bridge — narrow API surface
├── runtime/           # Independent TypeScript Agent, scheduler, storage, providers, CodeGraph
├── renderer/src/      # React 19 UI
│   ├── components/    # UI components (chat, cowork, settings, ssh, tasks)
│   ├── hooks/         # React hooks
│   ├── lib/           # Agent loop, tools, API clients, utilities
│   ├── locales/       # i18n JSON files (en/zh plus 11 other languages)
│   └── stores/        # Zustand stores
└── shared/            # Cross-process TypeScript contracts
```

**Entry points:** `src/main/index.ts` (main process), `src/renderer/src/App.tsx` (renderer).

**Key architectural patterns:**

- **IPC:** Renderer calls `ipcClient.invoke(channel)`, main handles in `src/main/ipc/*-handlers.ts`.
- **Agent runtime:** TypeScript runtime is the production target. Any remaining compatibility
  boundary is fail-closed and must not start an external worker; the exact exit state is tracked
  in the migration acceptance ledger.
- **Tool system:** Tools in `src/renderer/src/lib/tools/`, registered in phases (core → skills → sub-agents → teams).
- **Session modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — each with distinct prompts/tools/UI.
- **SQLite schema:** The TS BusinessRepository owns desktop writes. Preserve historical data and
  use versioned, tested migrations.
- **Data directory:** `~/.ola/` — never commit its contents.

## Build, Test, and Development Commands

```bash
npm run dev          # Start Electron + Vite with hot reload
npm run build        # Typecheck (main + renderer) then build
npm run build:win    # Full Windows installer (electron-builder)
npm run build:mac    # macOS .dmg/zip
npm run build:linux  # Linux .AppImage/.deb
npm run lint         # ESLint with cache
npm run typecheck    # TypeScript check (tsc --noEmit for both tsconfig.node.json & tsconfig.web.json)
npm run format       # Prettier (single quotes, no semicolons, 100-col width)
npm run postinstall  # Prepare native Electron dependencies
npm run verify:ts-migration-ledger  # Check migration acceptance inventory
npm run verify:ts-migration-exit    # Strict final gate; expected to fail until full migration
```

**CI:** GitHub Actions (`build.yml`) runs the TypeScript runtime, Electron, CodeGraph and Go quality gates on pull requests and `main`; the manual release workflow builds Windows, macOS and Linux on x64/arm64. No .NET worker or CodeGraph build is part of the production workflow.

## Coding Style & Naming Conventions

| Rule             | Convention                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Formatting       | Prettier: single quotes, no semicolons, 100-col width, no trailing commas                  |
| Indentation      | 2 spaces, LF line endings, UTF-8, final newline (EditorConfig)                             |
| React components | PascalCase (`Layout.tsx`)                                                                  |
| Stores/helpers   | kebab-case (`chat-store.ts`)                                                               |
| Path aliases     | `@renderer/*` → `src/renderer/src/*`                                                       |
| i18n             | `t('key', { defaultValue: 'English text' })` — never hardcode Chinese in UI                |
| Comments         | Explain intent, invariants, boundaries, or non-obvious behavior. Avoid restating the code. |

**Lint/format on save:** ESLint + Prettier enforce these rules automatically. Run `npm run lint` and `npm run format` before pushing.

## Testing Guidelines

**Behavioral tests use Vitest** (`tests/runtime/`); the staged Node runtime has its own typecheck. Validation includes:

- `npm run test:runtime` — isolated Agent, scheduler, model binding, SQLite, transport and CLI tests
- `npm run typecheck:runtime` — staged Node runtime and test types
- `npm run typecheck` — TypeScript compilation check across both main and renderer
- `npm run lint` — ESLint static analysis
- Manual smoke testing via `npm run dev`

When adding behavioral changes, run the affected behavioral tests and typechecks.

`src/runtime/` is the TypeScript implementation, but full Agent, channel, Cron and CodeGraph parity
has not passed. See `docs/migrations/ts-runtime/SUPPLEMENTAL-ACCEPTANCE.md` and
`acceptance-ledger.json` for the current migration gate. Remove each legacy path only after its
contract, data and end-to-end acceptance evidence is recorded.

## Commit & Pull Request Guidelines

**Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): description        # New feature
fix(scope): description         # Bug fix
chore(scope): description       # Maintenance, deps, build
refactor(scope): description    # Code restructuring without behavior change
```

Examples from the history: `feat(app): add code workspace and runtime enhancements`, `fix(mcp): expose connected MCP tools in chat`, `chore(release): bump version to 0.9.118`.

**Pull requests:**

- Link the relevant issue (if any).
- Include a brief description of what changed and why.
- Attach screenshots for UI changes.
- Ensure `npm run typecheck` and `npm run lint` pass.
