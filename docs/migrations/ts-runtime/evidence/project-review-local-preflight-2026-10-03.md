# Local project review template preflight — 2026-10-03

## Scope

The Electron integration run uses a seeded project whose working directory is created on disk in an isolated test data root. It verifies the project review template's UI path through project selection, directory preflight, and prepared read-only prompt. The test does not submit this prompt to a model, inspect project files with Agent tools, or prove an external Provider response.

## Observed path

1. Select the local personal workspace and the seeded local project from the new-task project selector.
2. Open the project review template. Its action remains gated until the real `fs:stat-path` directory check passes.
3. Prepare the prompt and verify that the composer contains the selected directory and an explicit read-only constraint.
4. Clear the selected project before the existing materials-to-report scenario; that scenario still completes its local Provider SSE fixture response.

## Verification

`npx electron-vite build` and `node scripts/verify-pending-session-queue-electron.mjs` passed (one Electron integration test). The test includes these project review assertions in `tests/runtime/pending-session-queue-electron.test.ts`. `npm run typecheck:runtime` passed after the repository's `updateSession` input type was aligned with the already supported `taskProfile` and `taskProfileLocked` database fields.

## Remaining

Run the project review through a real configured Provider and read-only Agent tools, review the cited file evidence, and verify no write action occurs. Real SSH inspection remains separate and unverified.
