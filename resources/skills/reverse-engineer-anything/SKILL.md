---
name: reverse-engineer-anything
description: Reverse engineer shipped binaries, packages, Electron/JavaScript apps, Android APKs, firmware and browser traffic with REA MCP tools; build AgentEnv bundles from a live web app or capture. Use when a claim depends on a shipped artifact, decompilation, or requested runtime evidence; skip ordinary source-repo architecture analysis.
---

# Reverse Engineer Anything (REA)

## License and permitted use

REA (upstream `rea-agents`, MIT licensed) is bundled here for lawful analysis:
security research and education, malware and incident analysis, vulnerability
research with coordinated disclosure, interoperability work, software
preservation, and debugging or auditing software the user owns or is authorized
to examine. The full boundary lives in `DISCLAIMER.md` and `LICENSE.txt` next to
this file; read them (via `FileName`) before escalating anything sensitive.

Do not use REA to circumvent DRM or license checks, bypass anti-cheat systems,
build game cheats, defeat authentication or access controls on systems the user
is not authorized to test, copy proprietary software or its protected assets, or
gain unauthorized access. Keep accurate safety and legal wording intact when
reporting this boundary to the user; do not soften it.

External engines remain the user's responsibility and licensing: Hopper, IDA and
JEB require the user's own commercial licences; Ghidra, JADX, Apktool, adb,
tshark, Binwalk and Unblob are user-supplied open-source or system tools.
Authorization to inspect an artifact does not authorize execution, traffic
interception, device mutation, or interaction with third-party systems.

## When to use

Use REA when a claim depends on a shipped binary or package, decompilation,
requested runtime evidence, or comparison with behavior not established by
available source. For ordinary analysis of a complete source repository, use
normal repository tools and do not run REA readiness or provider commands.

## Tool availability in Ola

REA capabilities arrive as MCP tools. In Ola they are named `mcp__rea__<tool>`
(for example `mcp__rea__open_binary`); the names below omit the `mcp__rea__`
prefix for brevity. Do not run `rea setup`, `rea doctor`, or any CLI that edits
agent configuration files: Ola owns its MCP registration.

- Enable REA in Settings -> MCP -> Rea and pick a category preset:
  `javascript`, `native`, `android`, or `web`. Each preset exposes a subset of
  the 229 pinned tools (native ~110, android ~64, javascript ~16, web ~10) plus
  shared core session/evidence operations. No CLI flag is involved.
- Engines are supplied by the user. A missing engine degrades only its category:
  - `native` needs Ghidra, Hopper, or IDA. Without one, decompilation,
    pseudocode, xref and deep-analysis tools vanish; file-format inspection
    tools (PE/ELF/Mach-O tables, notes, signatures) still work.
  - `android` needs headless JADX plus a full JDK, adb, and an Apktool launcher.
    Without them, class decompilation, device, and resource-decode tools vanish;
    manifest and archive inventory tools remain.
  - `web` needs a Chrome-family browser and, for packet summaries, tshark and
    capinfos. Without them, browser capture and pcap tools vanish.
  - `javascript` static analysis (ASAR or extracted Electron trees) needs no
    native engine at all.
- If an expected tool is missing, confirm the preset and the engine state above
  before anything else. If a required engine or provider is unavailable, read
  `references/connection-and-recovery.md`; note that its client-registration
  sections describe other hosts and do not apply to Ola's Settings-based setup.
- Oversized MCP results come back as a pointer: binary parts land under
  `.ola-results/mcp` in the working directory, and oversized text is written
  to a file whose absolute path is named in the result. Treat a preview as
  incomplete: never parse it as canonical JSON, and either read that file or
  re-query with a narrower view instead of repeating the identical producer
  call.

Node.js constraint: REA requires Node `^22.23.4 || ^24.22.1 || >=26.12.1`. The
machine's PATH node may be older; Ola then refuses the connection and shows an
actionable diagnostic. Report that diagnostic; do not install or upgrade Node on
the user's behalf without asking.

Fallback without MCP: a read-only CLI call such as
`npx -y rea-agents@6.8.0 analyze-javascript-application /absolute/path/to/app --json`
works through `Bash` for operator-supplied JavaScript trees; it needs no
registration or native engine. Never use the CLI to repair configuration.

## Loading reference guides on demand

This body is only the router. Playbooks live in `references/` and are not loaded
with the skill. To read one, call the `Skill` tool again with the same
`SkillName` and the file as `FileName` (one file per call, e.g.
`FileName: "references/native-and-artifacts.md"`). The skill's file list is
returned with this body. If the Skill tool cannot return the file, fall back to
`Bash` with an absolute path, e.g.
`cat /absolute/path/to/.agents/skills/reverse-engineer-anything/references/native-and-artifacts.md`
(the skill directory is returned as `workingDirectory` when this skill loads).

- Native binaries, managed assemblies, archives, extraction:
  `references/native-and-artifacts.md`
- ASARs, extracted JavaScript, feature tracing, version comparison:
  `references/javascript-applications.md`
- Android APK declarations, classes, methods, static references:
  `references/android-applications.md`
- Native instrumentation, debugger and process capture, browser/Electron
  observation, static/runtime comparison: `references/runtime-observation.md`
- Evidence paging, comparisons, residual unknowns, verification:
  `references/evidence-workflows.md`
- AgentEnv bundles of a web application from a live instance or a HAR:
  `references/environments.md`
- Connection, approval, timeout and provider blockers:
  `references/connection-and-recovery.md`
- External engine matrix, presets, Node requirement, output/timeout budgets:
  `references/engines-and-setup.md`

## Route the target first

Choose the first tool from the target the user supplied. `open_binary` binds
active-target native and archive workflows; target-free tools take their own
explicit path or endpoint and need no binding.

| Target                                                                     | First move                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native executable, library, or analysis database                           | `open_binary`, then focused analysis tools; `binary_overview` when metadata or inventory helps (not for IDA).                                                                                                         |
| Archive/package member inventory (ZIP/APK/IPA/MSIX/AppX, DMG, PyInstaller) | `open_binary` with the local path; `inspect_artifact` when the graph helps. Large inventories start at `detail: "summary"`.                                                                                           |
| ASAR or extracted JavaScript/Electron tree                                 | `analyze_javascript_application`.                                                                                                                                                                                     |
| Apple plist, Interface Builder, asset catalog, keyed archives              | `open_bundle_resources`, then the selected resource tool. No executable digest without `open_binary`.                                                                                                                 |
| Android APK code, classes, methods, incoming references                    | `inspect_android_package`, then focused Android tools when advertised.                                                                                                                                                |
| Managed PE/CLI assembly                                                    | `inspect_managed_artifact`.                                                                                                                                                                                           |
| Firmware image                                                             | `inspect_firmware_regions`; `extract_firmware` only when requested, with a caller-selected new output directory (user-supplied Binwalk/Unblob on Linux).                                                              |
| .NET NativeAOT PE/ELF                                                      | Native Ghidra analysis; optional metadata recovery per the NativeAOT section of `references/native-and-artifacts.md`.                                                                                                 |
| Live native behavior, calls, instrumentation                               | The matching native runtime workflow in `references/runtime-observation.md`. Runtime tools launch, attach, mutate, and clean up; they are not static analysis.                                                        |
| User-owned browser page already open                                       | `list_browser_targets`. Agent-performed actions: `capture_browser_scenario` with declared actions.                                                                                                                    |
| Agent environment (AgentEnv bundle) of a web app                           | Read `references/environments.md` before recording.                                                                                                                                                                   |
| Retained HAR/SAZ/mitmproxy/aioquic qlog capture                            | `inspect_web_network_capture`. Reads recordings; claims no live attribution.                                                                                                                                          |
| Recorded packet captures                                                   | Field-level: `inspect_packet_fields` then `inspect_packet_capture` with selected TShark fields. Summaries (endpoints, DNS, SNI): `inspect_pcap_capture` with detail summary, then retained pages. Never live capture. |
| Fiddler Everywhere traffic                                                 | `references/runtime-observation.md` Fiddler section; saved SAZ via `inspect_web_network_capture` with `format: "saz"`.                                                                                                |
| User-owned Electron runtime already open                                   | `list_electron_targets`; check `inspect_electron_fuses` before an electron-main Inspector attempt (`EnableNodeCliInspectArguments` disabled means `--inspect` is ignored).                                            |
| Recorded logic/signal traces                                               | `inspect_signal_decoders` first, then `decode_signal_recording` with explicit decoder and channel settings. Reads files; acquires no hardware signals.                                                                |
| Explicit local SQLite snapshot                                             | `inspect_sqlite_database`; read the compact schema first, then one ordinary table with selected columns (default 20 rows). Prefer quiescent snapshots over assumed-atomic live copies.                                |
| Existing IDA MCP configuration                                             | `open_binary` with the original input binary and `provider_id: "ida"`; never an `.idb`/`.i64` database. Then `analyze_function`, pseudocode, or searches directly.                                                    |
| With `REA_KUNA_COMMAND` configured                                         | `provider_id: "kuna"` for procedure lists, pseudocode, assembly and `analyze_function`; see the Kuna provider guide upstream for cache and coverage limits.                                                           |

Engine-free single-file inspectors (no active target, no disassembler) answer
format questions directly: `inspect_wasm_artifact`, `inspect_apk_signature`,
`inspect_evm_interface`, `inspect_go_binary`, `inspect_rust_binary`,
`inspect_pe_certificates`, `inspect_pe_imports`, `inspect_pe_load_config`,
`inspect_pe_resources`, `inspect_elf_notes`, `inspect_apple_ips`,
`inspect_kernel_module`, `inspect_python_pyc`, `inspect_erlang_beam`,
`inspect_model_artifact`, `inspect_il2cpp_metadata`, `inspect_gpu_code_objects`,
`inspect_native_exports`, `inspect_binary_layout` (pwntools), and
`inspect_recorded_crash` (Linux core). Each returns Evidence with its own
declarations: missing tables are observed absence, not proof of absence;
signatures are reported, not verified; WAT, pseudocode, and decoded bytecode are
transformations, not original source. Read the matching section of
`references/native-and-artifacts.md` before quoting any of them as a finding.

If the user says only "my app" with no name or path already selected, ask which
app before searching for artifacts. Nearby fixtures and saved reports do not
select the user's target. In a target-free session, bind each archive or native
tool with `open_binary`; call no unadvertised tool, and inspect
`binary_session` with `{}` for availability reasons and remediation. For a
Ghidra startup timeout on a large target, follow
`references/native-and-artifacts.md` deadline recovery (the default 330 seconds
is adjustable through `update_analysis_settings`, key
`ghidra.startup_timeout_ms`) before abandoning deep analysis.

## Work summary-first

- Start with the default result and its inline Evidence and graph context. For
  JavaScript applications or ELF layouts of unknown size, pass
  `detail: "summary"` and then page the retained `parent_evidence_id` with
  `inspect_analysis_view`. Over MCP, `analyze_function` is summary-first
  already; request `detail: "complete"` only when the dossier must travel inline.
- Page module identities and select the returned `node_id` before requesting an
  item; one file path can represent several graph roles.
- Do not repeat an identical analysis or a rejected call without a changed
  input or a resolved blocker. Make a follow-up only when the returned result
  leaves a specific question unanswered.
- On a `resource_constraint` with `details.resource: "transport"`, use
  `inspect_analysis_view` on the reported same-session Evidence reference for a
  summary, one section, or a stable page; use `export_evidence_bundle` to write
  the whole session to a path, or `get_evidence_bundle` with `detail: "summary"`
  when the parent ID is unknown. The analysis stays complete in the ledger.
- Every conclusion distinguishes observations, inferences, and unknowns. Cite
  Evidence IDs, preserve limitations and incomplete coverage, and never imply
  that static analysis observed execution. Runtime requests execute only the
  declared target and lifecycle; do not broaden them.
- Within the user's requested investigation, call available tools directly; REA
  needs no permission grants or per-call approval flags, though Ola may require
  its own approval for side-effecting calls.

## Plan broader investigations

For requests spanning multiple features or subsystems, work in stages:

1. Turn the request into a checklist of questions and the evidence each answer
   needs; resolve target identity from the conversation before asking again.
2. Inspect the current session, artifact identity, saved databases, bookmarks
   and prior evidence; reuse matching state instead of opening duplicates.
3. Start with the smallest useful overview; follow each question from entry
   point through data and state changes to its result; expand only when returned
   evidence leaves a concrete gap.
4. Inspect packaged resources and configuration alongside code when they affect
   the question; never infer behavior from filenames or strings alone.
5. Corroborate conclusions with the evidence type they require; use runtime
   observation only when static evidence cannot answer and the host supports it.
6. Decompose independent questions into parallel workers when available, each
   pointing at existing evidence and returning sources, conclusions, gaps.
7. Keep a finding ledger linking each conclusion to Evidence IDs, evidence type,
   search boundary, and remaining unknowns.

Before finishing, revisit the checklist and mark each question answered,
partially answered, or unresolved. Keep bounded negative searches bounded; do
not call a broad investigation complete while required questions remain open.

## Finish the task

Explain findings in plain language and tie them to returned Evidence IDs. When
the user asks to build something, use normal coding tools and separate observed
behavior from design choices. Close an opened native session with `close_binary`
when the investigation is complete.
