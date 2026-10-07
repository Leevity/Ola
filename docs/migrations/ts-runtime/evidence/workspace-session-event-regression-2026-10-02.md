# Workspace-scoped session events — 2026-10-02

## Defect and change

Under the TypeScript BusinessRepository write canary, the session-created/updated event path reread the session without a `workspaceId`. The repository correctly rejected that unscoped read with `TS_BUSINESS_WORKSPACE_REQUIRED`, so creating a new chat session could fail after the write. The same helper broadcast session payloads to every window, including windows registered to another workspace.

The Main IPC now passes the workspace already authorized by the request when it rereads a session and routes both update and deletion events only to windows registered for that workspace. Message batch events retain the workspace associated with each session in the batch.

## Verification

- `npx vitest run tests/runtime/db-ipc-message-scope.test.ts`: 19 tests passed, including the new workspace-scoped session creation regression.
- `npm run typecheck:node`: passed.
- ESLint on the changed Main IPC and affected tests: passed.
- `npx electron-vite build`: passed.
- `node scripts/verify-pending-session-queue-electron.mjs`: passed; 1 Electron integration test in 35.09 seconds.

The Electron scenario verifies report-template configuration and prompt preparation but does not claim a successful model run. P1/P10 and the strict runtime migration gate remain open pending broader feature-page and external acceptance evidence.
