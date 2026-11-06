# agent-desktop accessibility gate — `desktop_ax_*`

This file is the switch for Ola's accessibility-based desktop control. The seven Main-side
runtime tools (`desktop_ax_launch`, `desktop_ax_list`, `desktop_ax_snapshot`,
`desktop_ax_inspect`, `desktop_ax_click`, `desktop_ax_input_text`, `desktop_ax_adjust`) drive the
hash-pinned [agent-desktop](https://github.com/vercel-labs/agent-desktop) v1.1.0 CLI over the OS
accessibility tree (macOS AX, Windows UIA, Linux AT-SPI).

`npm run verify:desktop-ax-gate` reads the status table below and refuses any disagreement between
what this file claims and what the source actually enforces. `npm run
verify:desktop-ax-gate:strict` additionally refuses a single non-`pass` row; it is the release-time
form of the same check and is what must be run before the plugin is unhid.

While any row is not `pass`, the source must keep the feature unreachable. That coupling is
asserted in both directions, so a green table with a locked plugin is a failure just like a red
table with an open one.

Today the tools are registered in Main but no product flow requests them: `selectExplicitTools` keeps
a tool out of a run unless the run names it, and only the runtime-eligibility whitelist mentions these
seven names. The unhide checklist below is what turns that into a user-visible capability.

## Status

Scope is `static` when the gate verifier re-proves the row from source on every CI run, and
`platform` or `release` when it can only be closed by a named human on that machine.

| id                           | scope    | status  | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| argv-red-lines               | static   | pass    | `src/main/agent-desktop/args.ts` `FORBIDDEN_ARGV_TOKENS` / `FORBIDDEN_COMMAND_NAMES`, `tests/runtime/agent-desktop-args.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| headless-only                | static   | pass    | `src/main/agent-desktop/args.ts` emits no `--headed`; no source path falls back to headed on failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| approval-before-mutation     | static   | pass    | `src/main/runtime/runtime-tool-authorization.ts`, `tests/runtime/runtime-tool-authorization.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| unattended-refusal           | static   | pass    | `src/main/runtime/runtime-tool-authorization.ts` `desktop_ax_` branch ignores `whitelistedTools`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| backend-fail-closed          | static   | pass    | `src/main/runtime/desktop-ax-runtime-tools.ts` returns `[]` unless the probe says available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| allowlist-before-approval    | static   | pass    | `prepare` in `src/main/runtime/desktop-ax-runtime-tools.ts`, `desktop-ax-runtime-tools.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| binary-integrity-pin         | static   | pass    | `resources/agent-desktop.lock.json` per-binary sha256, `verifyAgentDesktopTrust` in `cli-client.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| result-budget-bound          | static   | pass    | `SNAPSHOT_MAX_CHARS` in `src/main/agent-desktop/snapshot-shrink.ts` under the 8000-char renderer clip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| guidance-when-unavailable    | static   | pass    | `detectAgentDesktop` in `src/main/agent-desktop/detector.ts`, `agent-desktop-detector.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| lockdown-coupling            | static   | pass    | `hidden: true` in `src/renderer/src/lib/app-plugin/types.ts`, force-disabled in `app-plugin-store.ts`, no run requests the seven names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ci-platform-coverage         | static   | pass    | `.github/workflows/build.yml` fetches the pinned binary and runs `test:agent-desktop` on the win, linux and mac jobs; the fixture is a shebang script, so spawn-backed cases stay POSIX and Windows proves argv, policy, shrinker and detector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| bundled-binary-signing       | static   | pass    | `scripts/agent-desktop-mac-sign.mjs` signs and checks the two pinned Mach-O files, `build/after-sign-mac.cjs` calls both halves, `scripts/verify-release-artifacts.mjs` refuses an ad-hoc or foreign-arch binary; `tests/runtime/agent-desktop-mac-sign.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| sbom-registration            | static   | pass    | `scripts/agent-desktop-sbom.mjs` turns the lock into SPDX packages and files, `scripts/release-sbom.mjs` emits them, `scripts/verify-release-artifacts.mjs` calls it; `tests/runtime/release-sbom.test.ts` pins all six published triples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| macos-accessibility-suite    | platform | pass    | Accessibility granted to Qoder.app, the app owning the shell that ran the recorder (not packaged Ola.app); darwin-arm64 macOS 25.6.0, backend `macos`, cli 1.1.0. `status` + `launch` + `snapshot` + `find` all ok on TextEdit (25 refs minted), System Settings (27) and Finder (49). One `type` via `--ref auto` → `delivery=delivered_verified retry=unsafe`, and the sentinel was read back independently by `find --text --count` = 3; one `click` via `--ref auto` → `delivery=delivered_unverified retry=unsafe`. Limits: `launch` reports the process, not a window, so a windowless already-running app yields `WINDOW_NOT_FOUND` (`--activate` is a red line) and a multi-instance `launch` yields `AMBIGUOUS_TARGET` |
| macos-snapshot-budget        | platform | pass    | real windows rendered through `inspectSnapshot` in the recorder process, no screen text on disk: Finder raw envelope 6690 chars from a `--skeleton -i` read → `rendered=2943/7800 hidden=2 markers=1 drill=true`; System Settings → `rendered=1712/7800 hidden=0 markers=1 drill=false`; TextEdit → `rendered=1240/7800 hidden=0 markers=1 drill=false`                                                                                                                                                                                                                                                                                                                                                                         |
| windows-uia-suite            | platform | pending | requires Windows 10 1809+ with Notepad and Explorer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| windows-text-input           | platform | pending | `desktop_ax_input_text` maps to `set-value` on Windows; the limit must be recorded, not assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| windows-twin-ref             | platform | pending | identical sibling controls may not be addressable by ref on Windows; the boundary must be measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| linux-x11-suite              | platform | pending | requires an X11 session; `scroll` has no semantic path on Linux                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| linux-wayland-refusal        | platform | pending | Wayland-only sessions must be refused explicitly rather than half-registered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| mac-signing                  | release  | pending | the mechanism passes (`bundled-binary-signing`); what is missing is one `.dmg` built with `OLA_MAC_CODESIGN_IDENTITY` set to the Developer ID, notarized, and `npm run verify:release` reporting the CLI as signed by the same team                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| windows-artifact-containment | release  | pending | `agent-desktop.exe` must stay inside `resources/agent-desktop/<triple>/` (P5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`status` accepts exactly `pass`, `pending`, `fail`. A `fail` row blocks the release form of the
gate and must name what failed.

## Closing a platform row

Run the recorder on the machine you are accepting. It only talks to the pinned binary and prints
summary-level evidence — exit codes, error codes, lengths, minted refs and control roles. Element
text, values and titles never leave the process, and the only application name in the block is the one
the operator passed to `--app`:

```bash
npm run fetch:agent-desktop
npm run verify:agent-desktop
npm run accept:agent-desktop                              # observation only
npm run accept:agent-desktop -- --app "System Settings"   # a deep window, to measure the budget
npm run accept:agent-desktop -- --app Finder --emit-refs  # the window that actually hides elements
npm run accept:agent-desktop -- --allow-action --action type --ref auto --emit-refs --text ola-ax-accept-1
npm run accept:agent-desktop -- --allow-action --action click --ref auto
```

Four things a platform row actually depends on:

- **The permission belongs to whoever runs the recorder.** macOS attributes an Accessibility grant to
  the app that owns the shell process, so granting it for a terminal run covers the CLI, not the
  packaged Ola.app. The two macOS rows below were closed from an agent shell and name that subject
  (`Qoder.app`) in their evidence. The in-app subject has to be accepted separately before the unhide
  checklist, and a row closed from a terminal names that subject in its evidence instead of claiming
  Ola.app was tested. Windows and Linux have no equivalent grant step, but UIA/AT-SPI availability
  still has to be read from `status`, not assumed.
- **`--emit-refs` and `--ref auto` are how an action gets aimed.** Refs are qualified `@<snapshot>:eN`
  identifiers that only unredacted output carries, so the recorder prints the ref/role pairs a run
  minted and `auto` selects the first element matching the verb's own role list. A bare `@e1` is
  refused before anything spawns, and so is any verb outside the semantic ten (`close-app`, `press`,
  `screenshot`, clipboard and notification verbs included). When no candidate role matches, the row
  stays `not-exercised` and the recorder prints the roles the CLI reported as present — an empty
  search is `NO_MATCHES` with a role list, not an error — so the next run aims with a fact instead of
  a guess.
- **`--text` is echoed into the block that gets pasted into this repository**, so a typed value has to
  be a synthetic sentinel. The recorder checks the character set and exits before any spawn otherwise.
  After a `type` it asks `find --text <sentinel> --count` how many times the sentinel is now on screen,
  which is the only self-check the redaction still allows; `NO_MATCHES` reads as a zero, not a broken
  probe.
- **The recorder never closes an application.** `close-app` is on the forbidden list, so whatever the
  run launched — and whatever a click opened — stays open for the operator to clean up by hand.

Paste the printed block into the row's evidence cell, replacing `pending` with `pass` only after
reading every step of that platform's sequence, and record the OS build and the backend the CLI
reported. The judgement belongs to that reading, not to the script: the rows a successful run prints
carry `review` precisely so a green-looking exit cannot become a `pass` on its own. A run without the
permission is a `fail`, not a skip, and Ola's own tools never trigger the prompt.

## Rules that are not rows

- No headed fallback. A headless failure is reported to the model as a failure. Nothing in Ola may
  retry a refused action with `--headed`, a screenshot, or a pointer move.
- Screen content is untrusted input. Application UI text enters the model context through the
  snapshot shrinker, so the closed schemas, the `allowedApps` bound and the fenced snapshot marker
  are the mitigation; a new verb is only admissible if it fits that shape.
- No unredacted surfaces. Clipboard, notification, raw key and physical-input verbs stay on the
  forbidden list even when the platform supports them.
- `verify:hooks` cannot pass on a Homebrew-node machine: it hard-links `process.execPath` into a
  temporary `.ola` directory, and a dylib-linked node then fails to load. Run that step on Linux CI.

## Unhide checklist

Only after `verify:desktop-ax-gate:strict` is green:

1. `src/renderer/src/lib/app-plugin/types.ts` — give the accessibility route its own builtin
   descriptor, not `hidden`, with `requiresModelConfig: false` and a description that names the OS
   permission it needs. The existing desktop descriptor is the superseded pixel route (screenshot plus
   coordinates, vision model required); it stays hidden and stays force-disabled, because the
   accessibility route replaces it rather than enabling it.
2. `src/renderer/src/stores/app-plugin-store.ts` — add `isDesktopAxToolAvailable()` for the new
   descriptor, backed by a real Main-side probe over IPC rather than a constant, so a machine without
   the binary or the permission cannot turn the plugin on and get nothing.
3. `src/renderer/src/lib/app-plugin/index.ts` — register the seven Main-owned names when that
   availability is true, so a run can request them.
4. `src/renderer/src/lib/app-plugin/desktop-routing.ts` — keep the pixel-route exclusion set and the
   routing decision consistent with the accessibility route.
5. `src/renderer/src/lib/ipc/ts-runtime-text-eligibility.ts` — move the seven names from the agent
   whitelist into the Chat whitelist once Chat is allowed to reach them.
6. `src/renderer/src/lib/app-plugin/*` — expose the `allowedApps` field in the plugin settings UI so
   a user can actually set the bound. Main already reads it: `resolveDesktopAxAllowedApps()` in
   `src/main/agent-desktop/allowed-apps.ts` merges the global and per-project plugin configuration and
   `desktop-runtime.ts` passes it into `createDesktopAxRuntimeTools()`, so an unset field means no
   bound rather than an empty one.
7. `src/renderer/src/locales/*/settings.json` — all sixteen locales for the new plugin strings;
   `verify:i18n` runs in strict mode and fails on any locale missing a settings key.
