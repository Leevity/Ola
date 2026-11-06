# Run-stream delivery after workspace revocation — 2026-11-05

Platform: macOS arm64, source build (`out/main/index.js`) plus an unsigned staged `.app`
(`dist-staged-mac/mac-arm64/Ola.app`). Isolated Ola data root, local OpenAI-compatible SSE
fixture; no real provider or main-site traffic.

## Defect and change

The pending-queue Electron scenario stalled while waiting for a run that had already completed in
the journal. Three defects in the personal-workspace revocation path caused that, and all three
were product defects rather than test artefacts.

1. `DesktopRuntime` passed the offline workspace directory straight to
   `RuntimeServer.revokeUnavailableWorkspaces`, whose contract is "the complete set of workspaces
   that are still permitted" (pinned by `tests/runtime/runtime-push-authorization.test.ts`). The
   directory never names `local-personal`, so the first read of it revoked every personal run's
   push. Revocation now goes through one wrapper that re-adds `LOCAL_PERSONAL_WORKSPACE_ID`, and
   the same constant the authority uses (`src/main/runtime/desktop-runtime.ts`).
2. Revocation removed subscriptions silently. A consumer parked on the stream never received a
   frame, so its `run.resync` reconciliation — and therefore the renderer's terminal state — never
   ran. Both revocation paths now use `dropSubscription(..., 'WORKSPACE_REVOKED')`, which sends the
   resync frame the client uses to re-subscribe from its cursor (`src/runtime/host/runtime-server.ts`).
3. `OfflineWorkspaceExpiryMonitor` re-armed on the directory's expiry timestamp. An already-expired
   directory keeps reporting the same timestamp, so the monitor re-read the directory — a network
   fetch plus a revocation pass — on a zero-delay timer as long as the app ran. It now ignores a
   timestamp it has already fired for (`src/main/runtime/offline-workspace-expiry-monitor.ts`).

## Test and fixture changes

- `tests/runtime/runtime-push-authorization.test.ts` asserts the release, not just the silence: after
  `revokeUnavailableWorkspaces`, the waiting consumer's `onResync` receives `WORKSPACE_REVOKED`.
  Before the fix the array stayed empty forever.
- `tests/runtime/pending-session-queue-electron.test.ts` seeds the custom extension by writing the
  registry file, which leaves no durable capability approval baseline, so `admitCall` failed closed
  with `EXTENSION_CALL_DENIED: pending-approval` and the tool surfaced only `TOOL_FAILED`. The
  scenario now approves the declared capabilities over `extension:capability-approve` — the same
  product channel the settings UI uses — before exercising an HTTP tool. This is a fixture gap, not
  a product regression.
- The Electron harness stops children by waiting for the real exit (`stopChild`) instead of a
  2-second race, adds the background-throttling switches to every launch, and reports the observed
  renderer/main state when a wait times out. These removed restart flakes that were unrelated to
  the run-stream defect.
- `tests/runtime/cron-session-recovery-electron.test.ts` resolved the asar entry with a hard-coded
  Windows separator and looked for `resources/app.asar` next to the macOS executable. Both now come
  from the running platform's layout, so the packaged scenario can run on macOS as well as Windows.

## Verification

- `npm run verify:pending-queue-electron`: 1/1 passed, 46.9 s; re-run after the final test edits, 1/1
  passed again.
- `OLA_PACKAGED_EXE=dist-staged-mac/mac-arm64/Ola.app/Contents/MacOS/Ola npx vitest run
tests/runtime/cron-session-recovery-electron.test.ts`: 1/1 passed, 20.4 s, against the staged
  package; the asar check reads `out/main/index.js` from the packaged payload.
- `npx vitest run tests/runtime/runtime-push-authorization.test.ts
tests/runtime/runtime-push-stream.test.ts tests/runtime/runtime-push-backpressure.test.ts
tests/runtime/desktop-runtime-revocation-stream.test.ts`: 7 tests passed.
- `npm run test:runtime`: 318 files passed, 7 skipped (the Electron scenarios behind their own
  gates). `npm run typecheck:runtime`, `npm run typecheck`, `npm run lint`: 0 errors.

## What this does not prove

The revocation evidence covers the local personal workspace against a stubbed offline directory and
a real team workspace revocation in the in-process harness; it does not exercise a signed-in
account, a real remote directory, or a second machine. The pending-queue scenario still uses a local
SSE fixture, so it proves journal/stream/persistence and UI reconciliation, not a real provider run.
The packaged cron result is from an unsigned `--dir` staging build, so it is not install, upgrade or
signing evidence for any platform. Phases P1/P3/P10/P12, `realSite` and the non-macOS-arm64 release
targets remain open.
