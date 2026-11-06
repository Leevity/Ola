# MCP naming budget, write outcomes, resource tools, and the AX staging pins — 2026-11-06

Platform: macOS arm64, source tree only. No provider, account, or main-site traffic; no packaged
app was built for this pass. This file closes the three P0 defects and two tooling gaps found while
auditing the uncommitted MCP work, and records the verification battery over the whole tree.

## What changed

1. **The tool-name segment budget was arithmetically wrong.** `mcp__<alias>__<tool>` has 64
   characters total, so the segment budget depends on the alias actually in use. The shared constant
   used a fixed figure that assumed a shorter alias than `MCP_ALIAS_MAX` (12), so a legal
   12-character alias with a 46-character advertised name produced a 65-character name and the tool
   was reported `TOO_LONG` — a tool that exists, is enabled, and is simply too long to ever be
   named. `MCP_TOOL_SEGMENT_MAX` is now the worst case derived from the same constants
   (`64 - 5 - 2 - 12 = 45`) and `mcpExternalToolName` passes the per-alias budget
   (`64 - 5 - 2 - alias.length`), with the FNV tail only when the cleaned segment still overflows.
   The comparison is made against the _sanitized_ length, because sanitizing collapses illegal
   characters and underscore runs, so a long dotted name can legally shrink into the budget
   (`src/shared/mcp-tool-policy.ts`).
2. **The renderer treated refused MCP writes as saved.** Main answers `mcp:add`, `mcp:update` and
   `mcp:remove` with `{success, error}` and validates the exposure policy and the atomic write
   before persisting anything. `mcp-store.ts` ignored that envelope: it appended the config to the
   list on a refused add, rewrote the record on a refused update, and dropped the row on a refused
   remove, so the UI showed a server the store file never got. Now `addServer` throws (the panel
   toasts `mcp.saveFailed`), `updateServer` and `removeServer` put the reason in
   `serverErrors[id]`, which the panel already renders, and the one write path with no awaiting UI —
   `debouncedSave`'s timer callback — catches and toasts instead of dropping an unhandled rejection
   (`src/renderer/src/stores/mcp-store.ts`, `src/renderer/src/components/settings/McpPanel.tsx`).
3. **Main registered no resource tools.** The renderer names MCP resources
   `mcp__<alias>__resource__<name>`, and `run.toolNames` carries that name, but the Main-side
   catalog built only tool entries, so a run that asked for a resource got an unknown tool. Main now
   registers one read-effect tool per advertised resource through the same naming function and the
   same segment convention, with the server id and URI bound at registration (the model passes no
   arguments), the artifact pipeline applied to the returned parts, the per-server result ceiling
   enforced, and the name kept only when it collides with neither a tool nor another resource
   (`src/main/mcp/mcp-runtime-tools.ts`, `src/main/mcp/mcp-manager.ts`).
4. **A truncated catalog looked like a complete one.** When capability discovery stops at the page
   limit, `McpClient.capabilitiesTruncated` was true in Main and invisible in the UI, so the panel
   presented a partial list as the server's whole surface. It now travels through
   `McpServerInfo.capabilitiesTruncated` into `serverTruncated[id]`, renders an explicit notice in
   the exposure section, and is cleared on disconnect, sign-out, and when Main returns no live
   client — the same stale-state rule that now clears `tools`, `exposedTools`, `resources` and
   `prompts` when `mcp:server-info` answers `undefined`
   (`src/main/ipc/mcp-handlers.ts`, `src/renderer/src/lib/mcp/types.ts`).
5. **The naming gate checked nothing.** `tools/verify-mcp-tool-naming.ts` passed preset _objects_
   where `resolveMcpEffectiveToolNames` reads `toolPresets: Record<string, string[]>`, so every
   preset resolved to "no preset" and the assertions silently covered only the spine list. It now
   builds the persisted shape, asserts the stored preset count, and requires each preset tool to
   reach the effective set.
6. **The accessibility pins were untested and the fail-open was undocumented.** Adds
   `tests/runtime/agent-desktop-staging.test.ts`: lock acceptance plus the five rejection shapes,
   the platform key, unpublished platforms, the entry version, `tarCommand` (including a real
   `System32/tar.exe` on Windows), and `inspectAgentDesktopBinaries` for complete, missing,
   `sha256`-drift and `size`-drift pins. `resolveDesktopAxAllowedApps` returning `[]` means
   "unbounded", not "nothing allowed"; `src/main/agent-desktop/allowed-apps.ts` now states why that
   is safe today — no renderer plugin registers `desktop-accessibility`, so nothing can write
   `desktopAllowedApps`, and the lockdown comes from `lockdown-coupling` in the gate table (no
   product flow names the seven tools), not from an empty allowlist.
7. **i18n.** `mcp.saveFailed` and `mcp.capabilitiesTruncated` were added to all 16 locales, and 26
   MCP exposure/preflight/diagnostic/runtime-limit strings in `zh/settings.json` that were still
   falling back to English were translated.

## Tests

- `tests/runtime/mcp-tool-policy.test.ts` (20): the longest legal alias at exactly the budget is
  whole, one character past it is elided and still `TOOL_NAME_MAX` long, a shorter alias buys a
  longer segment, and a loop over every alias shape × advertised lengths 1…256 never returns
  `TOO_LONG` and round-trips through `parseMcpExternalToolName`. Red with the fixed budget.
- `tests/runtime/mcp-store-write-outcomes.test.ts` (6, new): a refused add throws and leaves the
  list unchanged, a refused update keeps the config and records the reason, an accepted update
  merges and clears it, `refreshServerInfo(undefined)` clears the catalogs, `capabilitiesTruncated:
true` is recorded, and a refused remove keeps the server. Red against the ignored envelope.
- `tests/runtime/mcp-runtime-tools.test.ts` (12): the resource tool name, `/` sanitized inside the
  segment, `effect: 'read'`, `validate` discarding model input, `readResource(serverId, uri)` with
  the bound URI, no resource tool when Main cannot read resources, and one name kept when a tool and
  a resource collide.
- `tests/runtime/agent-desktop-staging.test.ts` (11, new).

## Verification

`npm run test:runtime` — **321 files passed / 7 skipped (328)**, **1559 tests passed / 10 skipped**
(60.1 s; the 7 skips are the Electron scenarios behind their own gates). The MCP, agent-desktop and
desktop-AX groups together: `npx vitest run` over 20 files — **232 tests passed** (4.8 s).

Battery over this tree, each line `PASS`/`FAIL` from the gate's own exit code, all `PASS`:

| gate                                   | result |
| -------------------------------------- | ------ |
| `test:runtime`                         | PASS   |
| `typecheck`                            | PASS   |
| `typecheck:runtime`                    | PASS   |
| `lint`                                 | PASS   |
| `verify:mcp-tool-naming`               | PASS   |
| `verify:tool-namer-stability`          | PASS   |
| `verify:mcp-autoconnect`               | PASS   |
| `verify:mcp-ipc-authorization`         | PASS   |
| `verify:mcp-oauth`                     | PASS   |
| `verify:desktop-ax-gate`               | PASS   |
| `verify:extension-capability-gates`    | PASS   |
| `verify:release-gates`                 | PASS   |
| `verify:legacy-artifacts`              | PASS   |
| `verify:i18n` (strict)                 | PASS   |
| `verify:ts-migration-ledger` (376/376) | PASS   |

`npx prettier --check .` is clean for everything tracked here; the only warning left in the
workspace is `.workbuddy/memory/2026-11-04.md`, an untracked scratch file that is not part of the
repository.

## What this does not prove

`npm run verify:desktop-ax-gate:strict` still exits 1 with exactly the seven platform- and
release-scoped rows open (`windows-uia-suite`, `windows-text-input`, `windows-twin-ref`,
`linux-x11-suite`, `linux-wayland-refusal`, `mac-signing`, `windows-artifact-containment`), so the
accessibility plugin stays hidden and no host other than this macOS arm64 machine has proven
anything. There is still no UI for the `desktopAllowedApps` bound — the app bound is read from
persisted plugin configuration that nothing in the product writes, so bounded runs are only
reachable once the plugin ships its settings surface; that is feature work gated on the rows above,
not a defect this pass hides.

The resource tools are proven against a manager stub, not a live MCP server that advertises
resources, and the truncation notice is proven at the store and markup level, not by a screenshot.
The naming and budget assertions run on the REA catalog fixture (`tests/fixtures/rea-tools.json`),
which is a recorded 229-name catalog rather than a live handshake. `verify:ci-electron` remains a
local-only entry point; no CI workflow change was made.
