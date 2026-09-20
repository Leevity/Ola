export type CapabilityLifecycleStatus = 'prototype' | 'internal' | 'beta' | 'ga' | 'deprecated'

export interface CapabilityLifecycleDefinition {
  id: string
  status: CapabilityLifecycleStatus
  highImpact: boolean
}

/** Product-facing lifecycle declarations kept in one place for settings and release audits. */
export const CAPABILITY_LIFECYCLE: readonly CapabilityLifecycleDefinition[] = [
  { id: 'local-agent-workspace', status: 'ga', highImpact: true },
  { id: 'remote-ssh-operations', status: 'beta', highImpact: true },
  { id: 'channel-automation', status: 'beta', highImpact: true },
  { id: 'browser-cookie-import', status: 'beta', highImpact: true },
  { id: 'media-generation', status: 'beta', highImpact: true },
  { id: 'unified-execution-audit', status: 'beta', highImpact: true }
]
