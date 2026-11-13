# Pale Inlet Drum plan closeout audit (2026-11-13)

Plan: `/Users/lqy-macmini/.qoder/plans/pale-inlet-drum.md`

This audit compares the plan's acceptance criteria with repository QA notes and this
closeout run. It does not treat an implementation, a source test, or a skipped check as
equivalent to the plan's required device or packaged-app evidence.

## Phase status

| Phase | Status | Evidence and open acceptance |
| --- | --- | --- |
| 0.1 baseline | Partial | Build, bundle, runtime tests and startup timings are recorded. The streaming profiler was sampled once in dev mode; a production before/after profile is still absent. |
| 0.2 source gates | Complete | Shared source-text helpers and semantic reverse checks are recorded in the Phase 0.2 QA memo. |
| 1 performance | Partial | Lazy loading, dead dependency cleanup, parallel Vitest projects and bundle budget are implemented. The renderer bundle and reverse test pass. Vitest has three stable wall-clock runs and a current peak-memory sample (5,176,918,016 bytes maximum RSS; no swap). Packaged `file://` startup failed in this closeout, so the `IronRdpViewer.tsx` `?url` asset remains unverified in asar; six-platform validation is absent. |
| 2 interaction/UI | Partial | Input forwarding, letterbox mapping, display selection and skeleton changes have source tests and API probes. No real dual-end remote control test was completed; this Mac has one display and Electron screen recording permission is denied, so pixel capture/multi-display selection and the TCC-denied UI path remain open. |
| 3 ola-task-v1 | Partial | Authorization, dispatch and receipt logic plus local Ola-admin integration are implemented and checked. The planned mobile-to-desktop full UI walkthrough has not been recorded. |
| 4 CodeMirror 6 | Partial | Spike capability harness, bundle measurements and worker `file://` probe pass. The six real app/SSH consumer smoke checks and asar packaged worker/startup remain unverified. |
| 5 input backend | Decision complete; platform acceptance open | The explicit gate chose to retain robotjs; nut.js migration was correctly not performed. Adapter/audit follow-ups are recorded. Real key, mouse and revocation smoke tests on six platforms have not run. |
| 6 Biome | Partial | Biome migration and architecture-boundary reverse checks pass; `design:check` was repaired and now passes all 8 outputs. However, 10 React Compiler-derived ESLint rules and React `no-unknown-property` have no replacement, `noComponentHookFactories` is off, and 128 exhaustive-deps warnings make `lint:ci` less strict than the old zero-warning gate. Six-platform CI evidence is absent. |
| 7 utilityProcess | Partial | Source Electron crash injection passed: utility PID changed, a run stream received resync, the active run was journaled as interrupted, and Main/renderer survived. The fresh macOS arm64 staging `.app` did not complete startup; packed crash injection and Windows/Linux packaged validation remain open. |

## Checks observed in the repository

Previously recorded green checks include runtime tests, typechecks, Biome lint/format, core
verification, migration ledger, renderer bundle budget, source Electron startup and source
Electron crash injection. This closeout reran `npm run test:runtime` under Node 24: 338 files and
1,700 tests passed, 7 files and 10 tests skipped, with a 24.70-second wall time and no swap.
The recorded three-run Vitest wall-clock comparison remains 22.17/21.93/21.87 seconds; the new
run supplies the missing memory observation, not another value for that comparison. This closeout also ran `npm run design:sync` followed by
`npm run design:check`; all 8 generated outputs verified.

`npm run build` passed its typecheck and source-build portions but electron-builder ran out of
heap while searching for node modules. The dedicated runtime staging package succeeded and
passed its asset and ad-hoc codesign checks. Its packaged startup probe then failed; details are
in [the packaged startup evidence](../migrations/ts-runtime/evidence/electron-packaged-startup-2026-11-13T03-45-17-218Z.txt).

## Completion decision

The plan is **not fully executed against its stated acceptance criteria**. Required acceptance
evidence remains for packaged startup, real dual-end remote control, real screen capture and
multiple displays, full mobile-to-desktop task UI flow, six consumer smoke checks, six-platform
input/runtime checks, and lint rule parity/strictness. Several items require a second device,
multiple displays, screen-recording authorization, or supported CI runners. The packaged startup
failure also needs investigation before the asar-dependent checks can pass.

Do not mark this plan complete until those criteria are either exercised successfully or the
plan is explicitly revised to accept a narrower target. No changes were committed.

## Local test environment check (2026-11-13)

The current Mac reports one 1920×1080 display. `adb` and Flutter are unavailable, and `xcrun`
resolves only to Command Line Tools (`xcode-select -p` is `/Library/Developer/CommandLineTools`),
so there is no iOS Simulator command-line runtime. Windows App has an active RDP session to
`10.125.29.157`; it is an occupied user desktop, not a clean test runner. No files were copied to
that host and no changes were made there. These checks confirm that the missing dual-end,
multi-display, simulator and cross-platform evidence cannot be produced safely from the current
local test setup.
