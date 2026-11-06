# REA as an Ola MCP server

[Reverse Engineer Anything](https://github.com/morluto/rea) (`rea-agents` on npm, MIT) is a stdio
MCP server plus CLI that orchestrates reverse-engineering engines the user already installed —
Hopper, Ghidra, IDA, JADX, adb, tshark, a Chrome-family browser. It ships **229 MCP tools** and
holds none of the analysis logic itself: every call is delegated to an external binary.

Ola integrates it over MCP. It is not vendored, not declared in `package.json`, and not shipped as
a Custom Extension — Ola extensions only support `kind: 'http'` and `kind: 'js'`, and the JS
handler sandbox is quarantined with no process or filesystem reach, which is exactly what REA needs.

## Why a whitelist is mandatory

Two hard limits make the full tool catalog unusable, and neither is ours to raise:

| Limit                   | Value                     | Owner                                               |
| ----------------------- | ------------------------- | --------------------------------------------------- |
| Tool name length        | 64 chars, `[A-Za-z0-9_-]` | Anthropic, OpenAI and Gemini request schemas        |
| `run.toolNames` per run | 128 names                 | `parseRunSpec` in `src/shared/runtime/contracts.ts` |

229 names cannot fit in 128 slots, so a REA server that advertises everything makes the **whole run
request invalid** — not degraded, invalid. Exposure is therefore capped per server at
`MCP_EXPOSED_TOOLS_MAX_PER_SERVER = 32`, chosen so the always-on spine (8) plus the widest category
preset (24) fits exactly, leaving the other 96 slots for Ola's built-in tools and any additional
servers.

`enabledTools` semantics are deliberately asymmetric: **absent means unfiltered** (every advertised
tool that fits the cap), `[]` means expose nothing. This keeps pre-existing configs working while
making the recipe's own list explicit.

## Tool identity: one alias, one pure function

The bug this design removes was silent: Main registered each tool under a name allocated in memory
by a stateful `ToolNamer`, while the renderer rebuilt `mcp__<serverId>__<toolName>` from the server
id. The two disagreed for long names and for any server id containing characters the sanitizer
rewrote, so the tool existed in Main and vanished from the model's view.

The external name is now a pure function of two stable inputs:

```
mcp__<toolAlias>__<segment>
   5        ≤12     2   ≤47      = 64 = TOOL_NAME_MAX
```

- `toolAlias` — lowercase, `_`-free, ≤ 12 chars (`ALIAS_PATTERN`). Chosen from the server's display
  name **once, at creation**, then frozen: `update()` drops `toolAlias` from any patch. Backfill for
  a stored server without one derives it from the immutable `id`, never the name, so renaming a
  server cannot re-key tools that transcripts already recorded.
- `segment` — the advertised tool name sanitized to ≤ 47. Over-length names get a stable
  `head_fnv1a32` tail rather than a plain truncation, so two long names sharing a prefix stay
  distinct. The longest REA name is 38 chars (`build_reconstruction_obligation_ledger`), so the
  recipe's names are never elided.

`mcpExternalToolName(alias, toolName)` in `src/shared/mcp-tool-policy.ts` is the only place the
string is built. Main computes it, puts it in `ExposedMcpTool.externalName`, and ships it over IPC;
the registry and the renderer consume that value instead of re-deriving. `resources` use the same
function with a `resource__` prefix, which the `_`-free alias makes unambiguous to decode.

Nothing is ever dropped without a trace:

| Condition                                   | Where it surfaces                                         |
| ------------------------------------------- | --------------------------------------------------------- |
| Tool not in `enabledTools` ∪ `activePreset` | `ExposedMcpTool.filtered`, listed in the panel            |
| Alias illegal, name empty                   | `ExposedMcpTool.reason` + `TOOL_NOT_EXPOSABLE` diagnostic |
| Capability page beyond 512 entries          | `McpServerInfo` truncation note                           |
| Preflight failure                           | `McpServerInfo.diagnostic`, banner in the server panel    |

`McpServerInfo.tools` is typed `AdvertisedMcpTool[]` — name and description only. Only the ≤ 32
exposed tools carry an `inputSchema` across the IPC boundary, so a renderer literally cannot
register a tool it was only told the name of.

## Node version preflight

REA pins `"node": "^22.23.4 || ^24.22.1 || >=26.12.1"`. Ola's Electron bundles its own Node, and
the stdio child is spawned from PATH, so those are two different answers — `process.version` is
never used. `src/main/mcp/mcp-preflight.ts` runs before `connect()` spawns anything:

1. resolve the interpreter the child will actually use (`preflight.nodeCommand`, default `node`) and
   probe it with `node -p process.version` under a 5 s timeout and a 256-byte output guard;
2. match against the range with the dependency-free `matchesNodeRange`;
3. check each `requiredCommands` entry on PATH (`PATHEXT` on Windows).

A probe that cannot be read is **unknown, not a failure** — the gate fails open, because an
unrelated shell quirk must not look like an unsupported runtime. Only `stdio` servers are probed; a
remote server's engines live on its host. Failures are reported through
`McpServerInfo.diagnostic` rather than a new `McpServerStatus` value, and the panel offers
**Ignore preflight** (`ignorePreflight`), which downgrades the block to a visible note.
`McpPreflightError` carries `retryable: false`, so `McpAutoConnectCoordinator` spends one attempt
instead of three, skips the backoff, and still opens the circuit.

This matters on the current development host: PATH Node is v25.6.1, which satisfies none of the
three branches. Connect will be blocked with an actionable hint until a supported interpreter is
configured.

## Output caps and spilling

A decompiler can return 400 KB of pseudocode. Ola's inline frame limit is 128 KB and the hard
ceiling is 24 MB, so the historical behaviour was `TOOL_OUTPUT_TOO_LARGE`: the answer existed and
was thrown away.

Now an oversized `content` array is reduced instead of rejected:

- `image` / `audio` / `resource` blocks collapse to a pointer to the files
  `materializeMcpArtifacts` already wrote, which land under
  `<workingDirectory>/.ola-results/mcp`;
- text larger than `outputLimits.inlineTextBytes` is written to the managed results directory —
  `<dataDirectory>/mcp-results/<sha256(workspaceId)>/<server>--<tool>-<digest>-<id>.txt`, so one
  workspace never reads another's output — and replaced inline with that absolute path, so the agent
  reads it with the file tools rather than re-requesting the call;
- with no managed directory, the text is truncated and the result still fits — the byte budget
  reserves room for the notice and JSON escaping, and the cut never splits a code point;
- anything the reduction cannot shrink (a huge non-`content` field) still fails
  `TOOL_OUTPUT_TOO_LARGE` against `outputLimits.maxResultBytes`. That is real protection, not an
  artifact of where we chose to write.

REA self-limits at 48 KB (`REA_MCP_MAX_RESPONSE_BYTES=49152`), so the recipe sets
`inlineTextBytes: 48 * 1024` and `maxResultBytes: 512 * 1024`: whatever REA keeps inline stays
inline, and the first byte past it spills to a file.

`timeoutMs` is raced per `callTool` (default 120 s; the recipe uses 300 s for JS/Web, 600 s for
Android, 900 s for Native because a Ghidra run holds a call open for minutes). A timed-out request
is abandoned and its late response is swallowed rather than delivered to a different call.

## Recipe

`src/shared/rea-mcp-recipe.ts` holds the data; nothing in it installs anything.

- **Alias** `rea`, package `rea-agents`, version `6.8.0`.
- **Env** `REA_MCP_INPUT_SCHEMA_PROFILE=compact` (smaller per-call context, canonical validation
  unchanged) and `REA_MCP_MAX_RESPONSE_BYTES=49152`.
- **Spine** (8, engine-free, always on): `inspect_analysis_settings`, `update_analysis_settings`,
  `binary_session`, `get_evidence_bundle`, `export_evidence_bundle`, `record_unknown`,
  `list_unknowns`, `update_unknown`.
- **Presets** (one active at a time, ≤ 24 each): `javascript` (24), `native` (24), `android` (24),
  `web` (20). All four target categories the integration is meant to cover stay reachable; presets
  are mutually disjoint and each is majority-own-category, because a handful of session and evidence
  tools legitimately serve several.
- **Active default** `javascript`, the only category that needs no external decompiler.

`command` and `args` are intentionally **not** in the recipe: they depend on where the user
installed the package. Pointing `command` at an explicit supported `node` binary is what makes the
version pin verifiable instead of PATH-dependent. `tests/fixtures/rea-tools.json` is the recorded
catalog the presets are validated against, and `npm run verify:mcp-tool-naming` re-checks every
preset name against it. Refresh that fixture after bumping `REA_MCP_VERSION` with `npm run
catalog:rea -- --package <path to the rea-agents package>`; the script reads the package's own
recorded catalog and only talks to a live server when passed `--live`.

## Skill

`resources/skills/reverse-engineer-anything/` is REA's own methodology skill, trimmed to Ola's skill
validator budget and split into `references/` (engine setup, per-category playbooks). It is bundled
as a built-in skill so the agent knows the workflow — session → evidence bundle → recorded unknowns
— instead of firing individual tool calls at a binary. The safety and licensing wording from the
source skill is kept; it was not softened to satisfy the risk scanner.

## What this integration is not

- No CLI pass-through tool, no lazy discovery meta-tool, no per-tool capability inference.
- Every `mcp__*` tool keeps `effect: 'write'` and per-call approval. REA's read-only-looking names
  still drive external binaries.
- No bundled or downloaded Node, no engine, no `ELECTRON_RUN_AS_NODE`.
- No HTTP transport for REA in this round.
- `TOOL_NAME_MAX` and the 128-name run budget stay where they are.

## Verification

```bash
npm run verify:mcp-tool-naming      # names, budgets, no second implementation in the tree
npm run verify:mcp-autoconnect      # retry, circuit and non-retryable behaviour
npm run verify:mcp-ipc-authorization
npm run verify:tool-namer-stability
npm run test:runtime                # mcp-tool-policy, mcp-name-agreement, mcp-preflight,
                                    # mcp-config-store, mcp-ipc-config, mcp-runtime-tools,
                                    # mcp-result-files, rea-presets, semver-range-lite
npm run verify:skill-quality
npm run verify:i18n
```

`verify:mcp-tool-naming` is part of `verify:ci-core`. Its source scan fails the build if any file
outside the shared policy composes an MCP name from a server id, which is the exact regression that
made tools disappear.

Run the gates on the Node CI uses, not whatever `node` is on `PATH`. On a host whose default is
v25.6.1, `verify:hooks` fails at `success.output.additionalContext` (a hook child that never sees
stdin close) and passes unchanged on v24.21.0 — the failure is the interpreter, not the tree.

Still manual, because no unit test can reach a real `rea-agents` install or a GUI:

1. Settings → MCP → add REA pointing at the local `rea-agents` package. With an unsupported Node the
   panel must show `NODE_VERSION_UNSUPPORTED` plus the copyable fix, and the server must stay out of
   the run prompt.
2. Point `command` at a supported Node and reconnect; the tool list must show spine + one preset, not
   229 entries.
3. Switch `activePreset` and watch the counter; the outgoing `tools/list` body must carry schemas only
   for registerable tools.
4. Run `mcp__rea__analyze_javascript_application` against a real unpacked Electron app: approval card,
   `Rea · analyze_javascript_application` in the tool card, and a >128 KB result landing as a file
   whose path the card can open.
5. Select the `native` preset with no Ghidra installed: only that category reports a missing engine
   and the server stays connected.
