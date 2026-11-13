import {
  TS_RUNTIME_UNMIGRATED_CAPABILITY_TOOLS,
  isUnmigratedTsRuntimeCapabilityTool
} from './ipc/ts-runtime-text-eligibility'

const DESKTOP_TOOL_NAMES = [...TS_RUNTIME_UNMIGRATED_CAPABILITY_TOOLS].filter((name) =>
  name.startsWith('Desktop')
)

export interface DroppedCapabilitySources {
  advancedDrawEnabled?: boolean
  videoGenerationEnabled?: boolean
  codeGraphEnabled?: boolean
  desktopControlEnabled?: boolean
  /** Tool names present in this run's registry snapshot (secondary signal). */
  snapshotToolNames: readonly string[]
}

/**
 * Resolve the quarantined capabilities a run must tell the user about.
 *
 * The settings / app-plugin switches are the source of truth for "the user turned this on".
 * The tool snapshot is only a secondary signal: tool registration is asynchronous (config
 * hydration, one-shot registerAllTools, React effects), so a snapshot taken before registration
 * used to produce an empty list — the capability was silently dropped with no transcript notice.
 * Every returned name is quarantined, so run-capability-labels.ts can always render a label.
 */
export function resolveDroppedCapabilities(input: DroppedCapabilitySources): string[] {
  const names = new Set<string>()
  if (input.advancedDrawEnabled) names.add('CanvasOperation')
  if (input.videoGenerationEnabled) names.add('GenerateVideo')
  if (input.codeGraphEnabled) names.add('codegraph_explore')
  if (input.desktopControlEnabled) {
    for (const name of DESKTOP_TOOL_NAMES) names.add(name)
  }
  for (const name of input.snapshotToolNames) {
    if (isUnmigratedTsRuntimeCapabilityTool(name)) names.add(name)
  }
  return [...names].filter(isUnmigratedTsRuntimeCapabilityTool)
}
