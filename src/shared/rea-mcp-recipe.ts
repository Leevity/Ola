// ── REA (rea-agents) MCP registration recipe ──
//
// REA advertises 229 tools; Ola caps what one server may expose at
// `MCP_EXPOSED_TOOLS_MAX_PER_SERVER` and the whole run at `MCP_RUN_TOOL_BUDGET`. This recipe is
// therefore a *curated* selection, not a partition of the catalog: a small always-on spine plus one
// activated category preset at a time. The names are literal so the selection stays auditable and
// so a REA upgrade that renames a tool shows up as an unknown entry instead of a silent gap.
//
// `tests/fixtures/rea-tools.json` pins the inventory these names were drawn from; the preset test
// asserts every name here still exists there.

import { MCP_EXPOSED_TOOLS_MAX_PER_SERVER } from './mcp-tool-policy'

export const REA_MCP_ALIAS = 'rea'
export const REA_MCP_PACKAGE = 'rea-agents'
export const REA_MCP_VERSION = '6.8.0'
export const REA_MCP_NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1'

/** Engine identifiers REA hands work off to. Advisory only — a missing engine degrades its category, never the server. */
export type ReaEngine =
  | 'ghidra'
  | 'hopper'
  | 'ida'
  | 'jadx'
  | 'jdk'
  | 'adb'
  | 'apktool'
  | 'jeb'
  | 'frida'
  | 'tshark'
  | 'chrome'
  | 'rizin'
  | 'binwalk'
  | 'wabt'
  | 'pwntools'
  | 'sigrok'
  | 'gdb'

/** Triage tools that stay exposed whatever preset is active. All are engine-free. */
export const REA_MCP_SPINE_TOOLS: readonly string[] = [
  'inspect_analysis_settings',
  'update_analysis_settings',
  'binary_session',
  'get_evidence_bundle',
  'export_evidence_bundle',
  'record_unknown',
  'list_unknowns',
  'update_unknown'
]

export interface ReaMcpPreset {
  tools: readonly string[]
  /** Engines the preset's tools delegate to; absent engines are reported per preset, not blocking. */
  engines: readonly ReaEngine[]
  /** Commands whose absence disables part of the preset. */
  requiredCommands: readonly string[]
  summary: string
}

export const REA_MCP_PRESETS: Record<string, ReaMcpPreset> = {
  javascript: {
    summary:
      'Static JavaScript / Electron analysis: application graphs, modules, source maps, routes, IPC and add-on boundaries. Needs no native decompiler.',
    tools: [
      'analyze_javascript_application',
      'compare_application_versions',
      'compare_javascript_export_shapes',
      'compare_source_to_bundle',
      'evaluate_reconstruction_coverage',
      'build_reconstruction_obligation_ledger',
      'trace_application_feature',
      'trace_javascript_semantics',
      'project_apple_application_graph',
      'project_harmony_application_graph',
      'project_managed_application_graph',
      'recover_javascript_sources',
      'inspect_analysis_view',
      'list_electron_targets',
      'list_javascript_runtime_targets',
      'observe_javascript_runtime',
      'inspect_electron_page',
      'inspect_electron_fuses',
      'reconcile_javascript_runtime',
      'capture_electron_scenario',
      'open_bundle_resources',
      'inspect_asset_catalog',
      'decode_interface_builder',
      'inspect_keyed_archive'
    ],
    engines: ['chrome'],
    requiredCommands: []
  },
  native: {
    summary:
      'Native binary investigation: pseudocode, assembly, procedures, strings, xrefs and call graphs. Needs the user’s own Hopper, Ghidra or IDA; Rizin/objdump cover the static subset.',
    tools: [
      'open_binary',
      'close_binary',
      'binary_overview',
      'analyze_function',
      'procedure_pseudo_code',
      'procedure_assembly',
      'batch_decompile',
      'decompile_all',
      'list_procedures',
      'search_procedures',
      'list_strings',
      'search_strings',
      'list_segments',
      'xrefs',
      'find_xrefs_to_name',
      'get_call_graph',
      'trace_call_path',
      'trace_native_values',
      'inspect_macho',
      'inspect_pe_imports',
      'inspect_binary_layout',
      'inspect_with_objdump',
      'execute_rizin_command',
      'inspect_native_instruction'
    ],
    engines: ['hopper', 'ghidra', 'ida', 'rizin'],
    requiredCommands: ['objdump']
  },
  android: {
    summary:
      'Android APK and connected-device analysis: manifest and class inspection, method decompilation, signatures, resources and adb device work. Needs JADX + a full JDK, and adb for device tools.',
    tools: [
      'inspect_android_package',
      'inspect_android_class',
      'inspect_android_method',
      'search_android_classes',
      'trace_android_references',
      'project_android_application_graph',
      'inspect_apk_signature',
      'decode_android_resources',
      'inspect_apktool_client',
      'open_jeb_project',
      'list_jeb_units',
      'decompile_jeb_item',
      'inspect_jeb_client',
      'identify_flutter_build',
      'inspect_dart_aot',
      'list_adb_devices',
      'inspect_adb_device',
      'list_adb_packages',
      'resolve_adb_packages',
      'pull_adb_package',
      'read_adb_logcat',
      'capture_adb_screen',
      'list_adb_processes',
      'start_adb_app'
    ],
    engines: ['jadx', 'jdk', 'adb', 'apktool', 'jeb'],
    requiredCommands: ['adb', 'java']
  },
  web: {
    summary:
      'Browser and network observation: page structure, scripted scenarios, screenshots, network captures and pcap decoding. Needs a Chrome-family browser; tshark covers recorded captures.',
    tools: [
      'list_browser_targets',
      'inspect_web_page',
      'capture_browser_scenario',
      'capture_web_screenshot',
      'compare_web_screenshots',
      'compare_web_captures',
      'inspect_web_network_capture',
      'observe_web_session',
      'observe_web_execution',
      'inspect_web_event_listeners',
      'analyze_web_bundle',
      'export_web_scripts',
      'trace_web_module_imports',
      'trace_web_source_location',
      'discover_webmcp_tools',
      'export_environment_bundle',
      'inspect_pcap_capture',
      'inspect_pcap_client',
      'inspect_packet_capture',
      'inspect_packet_fields'
    ],
    engines: ['chrome', 'tshark'],
    requiredCommands: []
  }
}

export const REA_MCP_PRESET_NAMES = Object.keys(REA_MCP_PRESETS)

/** Ghidra runs hold a call open for many minutes; everything else should fail fast. */
export const REA_MCP_TIMEOUTS: Record<string, number> = {
  core: 120_000,
  javascript: 300_000,
  native: 900_000,
  android: 600_000,
  web: 300_000
}

/**
 * The stored-config fields for a REA server. `command`/`args` are left to the caller because they
 * depend on where the user installed the package: pointing `command` at an explicit supported
 * `node` binary is what makes the version pin verifiable instead of PATH-dependent.
 */
export const REA_MCP_CONFIG_DEFAULTS = {
  name: 'Rea',
  description: `Reverse Engineer Anything (${REA_MCP_PACKAGE} ${REA_MCP_VERSION}, MIT). Local analysis; external engines required per category.`,
  transport: 'stdio' as const,
  enabled: true,
  env: {
    // Compact schemas keep the per-call context cost down; REA keeps full canonical validation.
    REA_MCP_INPUT_SCHEMA_PROFILE: 'compact',
    // Self-limit below Ola's 128 KB inline frame so results spill to files instead of failing.
    REA_MCP_MAX_RESPONSE_BYTES: '49152'
  },
  preflight: {
    nodeCommand: 'node',
    nodeRange: REA_MCP_NODE_RANGE,
    requiredCommands: []
  },
  // Aligned with REA's own self-limit: anything it still returns inline stays inline, and the
  // first byte past it spills to a file instead of failing the call.
  outputLimits: { inlineTextBytes: 48 * 1024, maxResultBytes: 512 * 1024 },
  timeoutMs: REA_MCP_TIMEOUTS.core,
  enabledTools: [...REA_MCP_SPINE_TOOLS],
  toolPresets: Object.fromEntries(
    REA_MCP_PRESET_NAMES.map((name) => [name, [...REA_MCP_PRESETS[name].tools]])
  ),
  activePreset: 'javascript'
}

/** Spine plus the widest preset must fit the per-server ceiling. */
export const REA_MCP_RECIPE_BUDGET = {
  spine: REA_MCP_SPINE_TOOLS.length,
  widestPreset: Math.max(...REA_MCP_PRESET_NAMES.map((name) => REA_MCP_PRESETS[name].tools.length)),
  perServerCap: MCP_EXPOSED_TOOLS_MAX_PER_SERVER
}
