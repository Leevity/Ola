# MEMORY.md - Ola Long-Term Memory

This file stores curated, durable memory for an Ola workspace.

Ola is a local-first AI multi-agent desktop platform. Its agents can inspect files, run shell commands, operate browsers, coordinate sub-agents, use MCP tools, schedule background jobs, and deliver results through messaging channels. Memory must make that power safer and more useful over time.

Memory is not a transcript. It is a compact operating map for future sessions.

## What To Remember

Keep facts that are stable, useful, and likely to improve future work:

- User preferences that affect collaboration.
- Project purpose, architecture, important paths, and common commands.
- Durable technical decisions and the reason behind them.
- Recurring workflows, verification steps, release steps, and deployment notes.
- Safety boundaries, approval preferences, and external-action rules.
- Lessons learned from mistakes that should change future behavior.
- Open work that should survive across sessions.

## What Not To Remember

Do not store:

- Passwords, API keys, tokens, private keys, recovery phrases, cookies, or one-time codes.
- Raw private messages unless the user explicitly asks and the content is necessary.
- Large logs, command dumps, or temporary debugging noise.
- Sensitive personal data unrelated to the work.
- Guesswork presented as fact.
- Short-lived task chatter that belongs only in the current conversation.
- Duplicate information already maintained in project files.

If sensitive information appears during work, handle it in-session only and redact it from summaries.

## Memory Layers

### Global Memory

Global memory describes the user's broad preferences and long-lived identity across projects. It should remain small and respectful.

Use it for:

- Preferred language.
- Communication style.
- Stable collaboration norms.
- Repeated safety preferences.

Do not use it for:

- Project-specific build commands.
- Temporary decisions.
- Private details unrelated to work.

### Workspace Memory

Workspace memory describes this project and how the user wants Ola to behave here.

Use it for:

- Repository structure.
- Key files and modules.
- Common commands.
- Product decisions.
- Known risks.
- Unfinished tasks.

### Daily Memory

Daily memory files such as `memory/YYYY-MM-DD.md` hold recent continuity and short-term notes.

Use them for:

- What changed today.
- Current debugging state.
- Temporary investigation notes.
- Follow-ups for the next session.

Promote an item from daily memory to this file only when it becomes durable.

## Entry Format

Use this format for durable entries:

```md
## [Category] Short Title

- Status: active | uncertain | outdated | archived
- Source: explicit user statement | observed workflow | project file | assistant inference
- Date: YYYY-MM-DD
- Confidence: high | medium | low
- Content:
  - ...
- Use When:
  - ...
- Do Not Use When:
  - ...
```

Keep entries short. If a memory needs pages of explanation, link to a project document instead.

## Current Workspace Context

### Project Identity

- Status: active
- Source: project files
- Date: 2026-07-02
- Confidence: high
- Content:
  - Project name: Ola.
  - Ola is a local-first AI multi-agent collaboration desktop platform.
  - The product goal is to turn programming, research, planning, automation, and cross-application workflows into natural-language conversations.
  - The product positioning is "intention as interface, language as productivity."
- Use When:
  - Writing prompts, templates, onboarding text, agent behavior rules, and product documentation.

### Architecture

- Status: active
- Source: `README.zh.md`, `AGENTS.md`, `CLAUDE.md`
- Date: 2026-07-02
- Confidence: high
- Content:
  - Ola is a four-layer Electron app: main process, preload bridge, renderer UI, and main-process agent runtime.
  - Main process handles system access, IPC, SQLite, shell, SSH, channels, MCP, cron, sync, and native worker integration.
  - Preload exposes a narrow safe bridge.
  - Renderer uses React 19, Tailwind, Zustand, i18n, Monaco, xterm, and chat/workflow UI components.
  - Shared contracts live under `src/shared`.
  - Native worker lives under `sidecars/Ola.Native.Worker` and uses MessagePack/local IPC for heavier native work.
- Use When:
  - Editing code or explaining system boundaries.
  - Deciding where a feature belongs.

### Runtime Capabilities

- Status: active
- Source: project files
- Date: 2026-07-02
- Confidence: high
- Content:
  - Session modes include `chat`, `clarify`, `cowork`, `code`, and `acp`.
  - Ola supports files, shell, grep/glob, browser control, goals, plans, sub-agents, teams, skills, custom extensions, MCP tools, SSH, cron agents, and messaging channels.
  - Messaging integrations include Feishu/Lark, DingTalk, Discord, QQ, Telegram, WeCom, Weixin, and WhatsApp.
- Use When:
  - Designing assistant behavior, permission prompts, or tool availability.

### Development Commands

- Status: active
- Source: `package.json`, `AGENTS.md`, `CLAUDE.md`
- Date: 2026-07-02
- Confidence: high
- Content:
  - `npm run dev`: start Electron + Vite development loop.
  - `npm run lint`: run ESLint with cache.
  - `npm run typecheck`: run TypeScript checks for node/preload and renderer.
  - `npm run build`: typecheck and build production output.
  - `npm run native:publish`: build the .NET native sidecar for the current platform.
  - `npm run format`: run Prettier.
- Use When:
  - Verifying changes.
  - Explaining local development workflow.

### Coding Conventions

- Status: active
- Source: `.editorconfig`, `.prettierrc.yaml`, `AGENTS.md`, `CLAUDE.md`
- Date: 2026-07-02
- Confidence: high
- Content:
  - TypeScript, React 19, Electron, Vite, Tailwind, Zustand.
  - 2-space indentation, UTF-8, LF, final newline.
  - Prettier uses single quotes, no semicolons, 100-column width, no trailing commas.
  - React component files use PascalCase.
  - Stores/helpers use kebab-case.
  - Renderer alias: `@renderer/*` maps to `src/renderer/src/*`.
  - UI strings should go through i18n; do not hardcode Chinese in UI components.
- Use When:
  - Editing source files.
  - Reviewing generated code.

## Memory Update Rules

Update memory when:

- The user states a stable preference.
- A project decision becomes durable.
- A repeated workflow becomes clear.
- A previous assumption is corrected.
- A safety boundary is established.
- An important unresolved task should survive across sessions.

Do not update memory when:

- The information is temporary.
- The information is sensitive.
- The assistant is guessing.
- The same fact already exists elsewhere.
- The memory would create clutter.

## Conflict Handling

When memory conflicts with the current conversation:

1. Prefer the latest explicit user instruction if it is safe.
2. Prefer project files over old memory for technical facts.
3. Ask only when the conflict could cause data loss, privacy exposure, external action, security risk, or wasted work.
4. After resolving the conflict, update or archive the stale memory.

## External Action Memory

Ola can deliver messages, trigger cron jobs, operate browsers, use network tools, and run commands. Remember user preferences about external actions carefully.

Default rule:

- Reading and local analysis can be proactive.
- Local edits inside the chosen workspace can be proactive when requested.
- Destructive, public, financial, identity, credential, or message-sending actions require explicit approval.

## Maintenance

Periodically prune this file:

- Archive completed tasks.
- Remove stale paths and old commands.
- Merge duplicates.
- Downgrade uncertain facts if they remain unconfirmed.
- Keep personal information minimal.

Good memory should make the next session start faster without making the assistant presumptuous.
