# Failure diagnosability and the local Electron aggregate — 2026-11-06

Platform: macOS arm64. Source build (`out/`) plus a re-staged unsigned `--dir` package
(`dist-staged-mac/mac-arm64/Ola.app`, built from this tree at 09:56 local). Isolated Ola data
roots, local OpenAI-compatible fixtures; no real provider, account or main-site traffic.

## What changed

Two diagnostics gaps from the pending-queue and Cron Electron runs stayed open after the
run-stream work, plus the Electron scenarios had no single entry point.

1. **A failed tool call left no cause.** `ToolExecutor` reports every thrown tool failure to the
   model as the fixed `TOOL_FAILED` token and recorded the identical result in the journal, so an
   after-the-fact read of a run could not distinguish a denied extension call, a lost browser
   connection, or an `ECONNRESET` in a path-bearing message. The journal now carries
   `tool.result.error` with a machine-safe token: a `RuntimeError.code`, otherwise the error's
   class name, otherwise `ERROR`. The model-visible output is unchanged, because error messages
   routinely contain paths, URLs and credentials (`src/runtime/tools/tool-executor.ts`).
2. **A cron job without a model binding vanished.** `parseCronModelBinding` returns `null` for an
   empty `model_source` column, so a fired job reached `runInternal` with no binding and threw
   `MODEL_NOT_SELECTED`. That promise is detached (`runTsCronAgentInBackground` is `void`), so the
   only trace was an unhandled rejection in the main-process log: no run row, no
   `cron:run-finished`, and a job that looked like it never fired. Such a run is now persisted as
   an `error` run and broadcast like any other failure, and the background wrapper logs anything
   that still escapes its own reporting. Failure reporting resolves the workspace from the job row
   instead of the missing binding, so the error that carries the message is no longer thrown away
   with the binding
   (`src/main/cron/ts-cron-agent-background.ts`).
3. **No aggregate for the Electron scenarios.** Adds `npm run verify:ci-electron`
   (`scripts/verify-electron-suite.mjs`), which sequences the seven source-mode scenarios and the
   two packaged-only ones, marks the packaged ones `skipped` when `OLA_PACKAGED_EXE` is unset, and
   prints a per-scenario summary. `--keep-going` runs the whole list instead of stopping at the
   first failure. It is a local entry point only: no workflow file was touched, and these
   scenarios still do not run in CI.

## Tests

- `tests/runtime/tool-artifact-events.test.ts`: one batch throws a `RuntimeError` code, a code that
  is really a path, an `Error` with a path-bearing message, and a raw string. The recorded
  `tool.result` events must be `BROWSER_NOT_CONNECTED` / `ERROR` / `TypeError` / `ERROR`, every
  model-visible output must stay `TOOL_FAILED`, and the serialized journal events must not contain
  the path. Red without the journal field, green with it.
- `tests/runtime/cron-unbound-model-run.test.ts`: an unbound scheduled job produces a created run
  row, an `error` update, and a `cron:run-finished` event carrying `MODEL_NOT_SELECTED` on the
  job's workspace (and on `local-personal` when the job row has no scope), never submits a runtime
  request, releases the job, and logs nothing as "escaped its own reporting". `createTsCronRunSpec`
  still throws `MODEL_NOT_SELECTED`, so the fail-closed boundary that builds a run request is
  unchanged. Red with the old `throw` in `runInternal`.

## Verification

`npm run verify:ci-electron -- --keep-going` with `OLA_PACKAGED_EXE` set to the re-staged
`dist-staged-mac/mac-arm64/Ola.app/Contents/MacOS/Ola`, every scenario in one run, exit code 0:

| scenario              | result | note                                                                                                          |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| startup               | passed | source harness (`out/main/index.js`), isolated data root                                                      |
| session-create        | passed | packaged app                                                                                                  |
| session-delete        | passed | packaged app, 30.7 s                                                                                          |
| settings-save         | passed | packaged app, 8.2 s                                                                                           |
| resources-command     | passed | packaged app, 45.5 s                                                                                          |
| top-level-pages       | passed | packaged app, 45.5 s, screenshots in `.../top-level-pages/installed`                                          |
| pending-queue         | passed | packaged app, 46.1 s — the scenario that stalled on the revocation defects                                    |
| packaged-startup      | passed | boots the `.app` directly; evidence written to `electron-packaged-startup-2026-11-06T01-59-38-487Z.{png,txt}` |
| cron-session-recovery | passed | packaged app restart, 1.9 s                                                                                   |

The same aggregate without `OLA_PACKAGED_EXE` (source mode, against `out/`) also exits 0: the seven
source scenarios passed and the two packaged-only ones are reported as `SKIPPED (set
OLA_PACKAGED_EXE)` rather than silently absent.

- Unit regressions: `npx vitest run tool-artifact-events cron-unbound-model-run` — 9 + 3 tests
  passed; each was confirmed red with its fix reverted.
- Closing gates on this tree: `npm run test:runtime` **319 files passed / 7 skipped** (59.8 s — the
  7 skips are the Electron scenarios behind their own gates), `npm run typecheck`,
  `npm run typecheck:runtime`, `npm run lint` and `npm run verify:ts-migration-ledger`
  (**376/376**) all exit 0 with no errors.

## What this does not prove

The tool-cause field is journal-only; no UI, execution record, or export surfaces it yet, so a
user still sees only `TOOL_FAILED` in the conversation. The cron fix covers the missing-binding
preflight; other pre-`run.submit` throws (a stale hosted binding that fails the workspace match, a
rejected run-start write) are logged rather than recorded as runs. `verify:ci-electron` runs on
this macOS arm64 host against an unsigned `--dir` package; it is not install, upgrade, signing, or
any other platform evidence, and it is not part of any CI gate.
