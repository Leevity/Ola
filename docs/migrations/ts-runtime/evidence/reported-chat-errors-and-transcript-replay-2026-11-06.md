# Reported chat error codes and transcript replay — 2026-11-06

Platform: macOS arm64, source tree plus the running `npm run dev` instance (Electron pid 8406).
Replay evidence is read-only against the app's real business database
(`~/.ola/backups/ts-handover/data-1789870112341-449c509f-bd9e-4ed5-9811-573cf0ec69d8.db`,
37 sessions). No real provider, account or main-site traffic; the projection checks are local.

## What was reported

Three different codes appeared in one working session, all of them reported by the user as
"Agent failed …", in `~/.ola/logs/crash-2026-11-06.log`:

| code                                                         | count | first    | last     |
| ------------------------------------------------------------ | ----- | -------- | -------- |
| `REQUEST_FAILED` (runtime request frame)                     | 8     | 06:04:37 | 07:20:30 |
| `TS_RUNTIME_TEXT_REQUIRED` (composer recommendations)        | 3     | 07:19:48 | 07:39:12 |
| `TS_RUNTIME_AGENT_UNAVAILABLE: MESSAGE_CONTENT_NOT_MIGRATED` | 4     | 07:39:20 | 07:39:42 |

They are three unrelated defects, and none of them named itself: the first two are flattened
tokens, and the third is a migration reason that reads as a missing capability.

## What changed

1. **An expired account token switched off local chat.** `DesktopRuntime` built the runtime
   authority with `new Set([LOCAL_PERSONAL_WORKSPACE_ID, …await loadOfflineWorkspaceIds()])`, so a
   directory read that threw — a 401 on a session that had expired — threw before the literal was
   ever added, and every runtime request, including a locally configured provider, was rejected.
   The set is now produced by `permittedWorkspaceIds` (`src/main/runtime/workspace-authority.ts`),
   which always permits `local-personal` and only adds hosted ids it could actually verify, the
   same rule the Cron scope query already applies (`src/main/db/cron-dao.ts`). Hosted runs stay
   forbidden in that state, because the ids that were withheld are exactly the ones that cannot be
   trusted. Wired in at `src/main/runtime/desktop-runtime.ts:435`.
2. **A failed request frame discarded its cause.** `RuntimeServer` answered
   `error instanceof RuntimeError ? error.code : 'REQUEST_FAILED'`, so a `ModelBindingError` —
   `ACCOUNT_UNAVAILABLE` among them — reached the renderer as `REQUEST_FAILED` and the real cause
   existed nowhere. The code now comes from `requestFailureCode` (`src/runtime/host/runtime-server.ts:34`),
   which recognises both contract error classes; when a frame still gets the fixed token, the
   main-process log records the method and the error before answering, because otherwise the only
   trace of a failed request is the text the user sees.
3. **One thinking reply disabled the whole session.** `assessTsRuntimeTextEligibility` rejected
   any content block it could not put on the wire, so `thinking`, `agent_error`, `image_error`,
   `tool_use` and `tool_result` — every one of which the renderer does write to the transcript —
   raised `MESSAGE_CONTENT_NOT_MIGRATED` from turn 2 onward. `RuntimeTextMessage` carries role,
   text and images only (`src/shared/runtime/contracts.ts:84`), so those blocks now leave the
   replay instead of failing the conversation, and a turn that keeps no replayable text drops out
   of the history entirely (`src/renderer/src/lib/ipc/ts-runtime-text-eligibility.ts:305`, `:238`).
   Shapes the contract genuinely cannot carry — an `extension` block, a non-`https` image url,
   more than 4 images, a `role: 'tool'` message, a transcript whose tail is an unfinished tool
   round — still fail closed.
4. **Auxiliary text requests reasoned, then reported nothing.** Composer recommendations, session
   renames, memory automation and the draw-prompt optimiser inherit the chat provider, so they
   inherited its reasoning effort into a 256-token budget: the completion could be all thinking and
   no text, which `runTsTextRequest` then collapsed into `TS_RUNTIME_TEXT_REQUIRED` along with
   every stream error. `withAuxiliaryResponsesRequestPolicy` now forces
   `thinkingEnabled: false` / `reasoningEffort: undefined` for every provider type, not only
   `openai-responses` (`src/renderer/src/lib/api/responses-session-policy.ts`), and
   `runTsTextRequest` logs the eligibility reason, the stream error and the empty-completion case
   separately (`src/renderer/src/lib/ipc/agent-bridge.ts`).

## Tests

- `tests/runtime/workspace-authority.test.ts` (4, new): a directory read that throws still yields
  `local-personal`; hosted ids appear only when the read succeeds; the warning names the state.
- `tests/runtime/runtime-request-failure.test.ts` (3, new): over a real IPC socket, a
  `ModelBindingError` is answered with `ACCOUNT_UNAVAILABLE` rather than `REQUEST_FAILED`, a
  `RuntimeError` keeps its own code, and a non-conthrowing-shape failure still gets the fixed
  token. Each behaviour uses its own socket, because a failure on an unauthenticated socket closes
  it.
- `tests/runtime/ts-runtime-text-eligibility.test.ts` (15, +2): a reasoning-model transcript
  projects to the surviving text, an `agent_error` card is dropped, a reasoning-only turn leaves
  `history: []`, and a completed tool round keeps both texts without the traffic. The fail-closed
  cases (`role: 'tool'`, `file://` image) are unchanged.
- `tests/runtime/auxiliary-request-policy.test.ts` (2, new): a `reasoningEffort: 'medium'` +
  `thinkingEnabled: true` provider comes back non-reasoning, with no `reasoningEffort`, `thinking`
  or `bodyOverrides` in the projected model options, and the `openai-responses` path still binds
  `responsesSessionScope` and `websocketMode: 'disabled'`.

## Live transcript replay

The 12 largest sessions in the real database were replayed read-only through
`assessTsRuntimeTextEligibility` with one synthetic next user turn appended — exactly the send the
user reported as failing — against the pre-fix file checked out from `HEAD`, then against the fix.
DB census: 51 assistant messages containing `thinking`, 33 containing `tool_use`, 168
`tool_result` user messages, 7 `agent_error` cards.

| session                 | messages | shapes                                  | before fix                     | after fix            |
| ----------------------- | -------- | --------------------------------------- | ------------------------------ | -------------------- |
| `vLjWdLejGCcZUSYrx2hWY` | 87       | `thinking` + `tool_use` + `tool_result` | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 33 |
| `4rpmxO_254Pu4FSVREU20` | 47       | `thinking` + `tool_use` + `tool_result` | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 16 |
| `lchN_9BSAYvFLbNGGR7Lr` | 45       | reasoning-only turns plus tool traffic  | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 16 |
| `4lp3TVztW23KVYauAio37` | 22       | tool round without thinking             | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 21 |
| `jMDltRJONOo4JhTMlyKbF` | 10       | `assistant: agent_error`                | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 8  |
| `hihn-msuEycXoXa70Odyh` | 10       | `thinking` + `tool_use` tail            | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 5  |
| `m3Hs0PBuqyfYH_otFLHJZ` | 11       | one assistant turn with 60+ tool calls  | `MESSAGE_CONTENT_NOT_MIGRATED` | eligible, history 2  |

**0/12 eligible before the fix, 12/12 after.** The reported session itself,
`0qKWJU652VISFetjaU2GQ`, is 7 messages whose second entry is `assistant: thinking + text` — the
shape that made every later send in that chat fail.

In the running instance, `REQUEST_FAILED` stopped appearing at 07:20 (the authority fix), the two
remaining log lines for the workspace directory are the intended
`workspace directory unavailable; serving the local workspace only` warning, and the only surviving
401 is `remote:account:invoke:msgpack`, which costs cloud/team workspace availability until
re-login and no longer affects local runs.

## Verification

- `npx vitest run ts-runtime-text-eligibility auxiliary-request-policy workspace-authority runtime-request-failure` — **4 files / 24 tests passed**.
- `npm run test:runtime` — **324 files passed / 7 skipped, 1570 tests passed / 10 skipped** (69.6 s; the 7 skips are the Electron scenarios behind their own gates).
- `npm run typecheck`, `npm run lint`, `npx prettier --check .` and `npm run verify:ts-migration-ledger` (**376/376**) exit 0.
- Both renderer fixes were confirmed live: Vite served the transformed modules to the running
  window (pid 8406), and the window was reloaded before the retry.

## What this does not prove

Replaying text without tool traffic is lossy by design, and it is the user's chosen trade-off: the
model no longer sees which files a previous turn read or wrote, so a long Execute session can
repeat work or contradict itself. The contract-level fix — a history entry that carries tool calls
and results — is still unmigrated; `src/runtime/core/agent.ts:26` continues to materialise
assistant history with `toolCalls: []` even though the codecs already support the real shape, so
the gap is the wire contract, not the engine.

The eligibility projection is not a model round-trip: it proves a send is no longer refused, not
that the answer is as good as it would be with full tool context. A transcript whose latest turn is
an unfinished tool round is still rejected as `CURRENT_PROMPT_NOT_MIGRATED`, and no data was
rewritten to make the 12 sessions replay. `ACCOUNT_UNAVAILABLE` reaching the client tells the user
what is wrong but does not re-authenticate them. Auxiliary requests are simply barred from
reasoning; a future caller that genuinely needs it must opt in explicitly. `verify:ci-electron` is
still not wired into any workflow.
