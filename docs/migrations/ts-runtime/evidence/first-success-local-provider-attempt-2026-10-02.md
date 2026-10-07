# First-success local Provider execution — 2026-10-02

## Scope

The Electron integration test executes the materials-to-report template end to end against an isolated local OpenAI-compatible SSE fixture. It does not contact an external Provider or prove real account, MCP, channel, or production-service behavior.

## Verified local fixture path

1. Open the report template and enter source material and report scope.
2. Pass the template preflight and place the prepared prompt in the composer.
3. Submit the prompt and explicitly confirm the execution-mode change.
4. Verify the fixture receives the source material and returns an SSE response.
5. Verify the response appears in the conversation.
6. Verify the memory automation record is workspace-scoped and task-profile/session updates do not emit persistence errors.

## Defects corrected

- A default `maxTurns: 0` (unbounded) was sent into a runtime contract that only accepts explicit limits from 1 through 128. The renderer now omits the field when the configured value means “unbounded.”
- The run parser treated the Provider system prompt as a single-line identifier and rejected normal newlines and tabs. System prompts now accept printable text plus line breaks and tabs, while still rejecting other control characters.
- Main required a non-empty API key even when the Provider explicitly set `requiresApiKey: false`. The default remains fail-closed; empty credentials are accepted only with that explicit flag.
- Memory automation carries the source session workspace for synthetic records and scopes Main lookups; the final Electron run did not report `db-workspace-required`.
- The session update failure was caused by task-profile fields missing from the TS SQLite schema and update contract. Schema v10 now adds `task_profile` and `task_profile_locked`, and session create/update/read paths persist them. A focused repository round-trip test covers the values.

## Result

`npx electron-vite build` completed, then `node scripts/verify-pending-session-queue-electron.mjs` passed: 1 Electron integration test. It includes queue recovery, multi-workspace switching, terminal layout persistence, artifact and session-delete scenarios, the report template's actual local Provider request and displayed response, plus memory and session persistence error assertions.

Related focused coverage: `tests/runtime/run-model-options.test.ts` (17 tests), `tests/runtime/memory-workspace-authorization.test.ts`, `tests/runtime/pending-session-queue-recovery.test.ts`, and `npm run typecheck` passed after the changes.

Remaining S4 acceptance: complete real-path verification for project read-only inspection and SSH read-only inspection, plus authenticated Provider/MCP/channel health checks. This local fixture does not close those items.
