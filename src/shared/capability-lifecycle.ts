export type CapabilityLifecycleStatus = 'prototype' | 'internal' | 'beta' | 'ga' | 'deprecated'

export interface CapabilityLifecycleDefinition {
  id: string
  status: CapabilityLifecycleStatus
  highImpact: boolean
}

/**
 * Product-facing lifecycle declarations kept in one place for settings and release audits.
 *
 * The optional workbenches stay listed here so their delivery stage is explicit rather than
 * implied: they are reachable from their own entry points, they are never promoted into the
 * primary navigation, and none of them is a dependency of the core workspace flow.
 */
export const CAPABILITY_LIFECYCLE: readonly CapabilityLifecycleDefinition[] = [
  { id: 'local-agent-workspace', status: 'ga', highImpact: true },
  { id: 'remote-ssh-operations', status: 'beta', highImpact: true },
  { id: 'channel-automation', status: 'beta', highImpact: true },
  { id: 'browser-cookie-import', status: 'beta', highImpact: true },
  { id: 'media-generation', status: 'prototype', highImpact: true },
  { id: 'unified-execution-audit', status: 'beta', highImpact: true },
  { id: 'draw-canvas', status: 'beta', highImpact: false },
  { id: 'pet-companion', status: 'beta', highImpact: false },
  { id: 'novnc-remote-desktop', status: 'beta', highImpact: true }
]
