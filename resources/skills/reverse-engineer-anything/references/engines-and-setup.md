# Engines, presets and runtime budgets (Ola)

This file is Ola-specific. It documents how REA's upstream `rea-agents@6.8.0`
package maps onto Ola's Settings -> MCP -> Rea presets, which external engines
each category expects, and the resource budgets that shape results.

## Node.js requirement

REA declares `engines.node` as `^22.23.4 || ^24.22.1 || >=26.12.1`. The Node on
the machine's PATH can be older than that range; Ola then refuses to connect the
Rea server and surfaces an actionable diagnostic naming the required range. Do
not work around it by editing REA internals. Ask the user to install or point
Ola's MCP launcher at a supported Node, and re-check from Settings -> MCP.

## Presets and tool counts

The counts come from the pinned 6.8.0 recorded MCP catalog (229 tools total).
Ola presets are literal name lists drawn from that inventory:

| Preset       | Category tools | What it is for                                                                            |
| ------------ | -------------- | ----------------------------------------------------------------------------------------- |
| `native`     | 110            | Native binaries, archives, firmware, PE/ELF/Mach-O tables, disassembly and decompilation. |
| `android`    | 64             | APK/AAB code, manifest, resources, signing, and adb-connected devices.                    |
| `javascript` | 16             | ASAR and extracted Electron/JavaScript application analysis.                              |
| `web`        | 10             | Browser capture, saved network captures, packet summaries.                                |
| (shared)     | 29             | Core session, evidence, and paging operations that accompany any preset.                  |

## External engine matrix

REA never installs engines. Each category degrades independently: missing
engines remove only the tools that need them, and the remaining tools keep
working.

| Category     | Engines the user must supply                                                                                                                                                               | Tools lost when absent                                                                             | Tools that still work                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`     | One of Ghidra (open source), Hopper (commercial licence), IDA (commercial licence, via an existing ida-pro-mcp style registration), or Kuna (`REA_KUNA_COMMAND`)                           | Decompilation, pseudocode, xref/graph and deep-analysis routes for `open_binary` targets           | Format inspectors needing no engine: PE/ELF notes, imports, load config, resources, `inspect_apple_ips`, `inspect_kernel_module`, `inspect_python_pyc`, `inspect_erlang_beam`, `inspect_model_artifact`, `inspect_apk_signature`, `inspect_evm_interface`, archives/inventories |
| `android`    | Headless JADX plus a full JDK (Linux/macOS/Windows x64), adb (`REA_ADB_PATH`), Apktool launcher (`REA_APKTOOL_COMMAND`); JEB is optional and commercial                                    | Class/method decompilation, device operations, resource decoding                                   | Manifest and archive member inventory, signature inspection                                                                                                                                                                                                                     |
| `web`        | A Chrome-family browser (`REA_BROWSER_EXECUTABLE`); tshark 4.x and capinfos for packet captures (`REA_TSHARK_COMMAND`, `REA_CAPINFOS_COMMAND`); mitmdump/aioquic for those capture formats | Live browser targets, `capture_browser_scenario`, `inspect_packet_capture`, `inspect_pcap_capture` | Reading retained HAR/SAZ/qlog files via `inspect_web_network_capture`                                                                                                                                                                                                           |
| `javascript` | None for static analysis (Node/npm only; Linux uses procps-compatible `ps` for process follow-ups)                                                                                         | Only Electron process-attach helpers if `ps` is missing                                            | Full static ASAR/extracted-tree analysis, source maps, routes, IPC graph                                                                                                                                                                                                        |

Other engines named in upstream guides remain caller-supplied environment
variables: `REA_BINWALK_COMMAND`/Unblob (firmware, Linux), `REA_GDB_COMMAND` and
pwntools (crash/layout work), `REA_WABT_BIN_DIRECTORY` (WASM),
`REA_SIGROK_COMMAND` (signal recordings, Linux with util-linux prlimit).

## Output and timeout budgets

Ola wraps every MCP tool with fixed budgets; they bound what comes back per
call, not what REA computes:

- Tool input is capped at 64 KB serialized; oversized arguments are rejected
  before reaching REA.
- Results above the inline budget come back as a pointer: file-bearing parts
  are spilled under `.ola-results/mcp` in the working directory and oversized
  text to a managed file named by absolute path in the result. A 24 MB hard
  limit rejects anything larger outright. Treat previews as incomplete and page
  the retained Evidence (`inspect_analysis_view`) or export a bundle instead of
  re-running the producer.
- REA skill files loaded through the `Skill` tool's `FileName` argument are
  capped at 128 KB per file.
- Ghidra startup defaults to 330 seconds, adjustable for new attempts through
  `update_analysis_settings` with `ghidra.startup_timeout_ms`;
  `REA_GHIDRA_STARTUP_TIMEOUT_MS` and `REA_HOPPER_STARTUP_TIMEOUT_MS` apply at
  server launch and therefore need a reconnect.
- Capture decoding retains old-generation heap under
  `REA_CAPTURE_DECODER_OLD_GENERATION_MIB` (default 192 MiB, floor 8, maximum
  16384), set where the REA server starts; host free memory and `NODE_OPTIONS`
  do not raise it.
- SQLite inspection needs Node 24.x >= 24.15 or 26+ for native SQLite limits.
- Recorded packet and signal outputs default to 50 rows/lines per page
  (`match_offset`/`match_limit`, `line_offset`/`line_limit`); explicit null
  limits request everything remaining.
