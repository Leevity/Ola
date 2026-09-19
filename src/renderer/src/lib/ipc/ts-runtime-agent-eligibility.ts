import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import type { ModelOptions } from '../../../../shared/runtime/model'
import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import type { RuntimeTextMessage } from '../../../../shared/runtime/contracts'
import {
  assessTsRuntimeTextEligibility,
  supportsTsRuntimeAgentTools
} from './ts-runtime-text-eligibility'

export type TsRuntimeAgentEligibility =
  | {
      eligible: true
      modelSource: ModelSource
      prompt: string
      history: RuntimeTextMessage[]
      modelOptions: ModelOptions
    }
  | { eligible: false; reason: string }

/**
 * Explicit migration gate for Execute mode. Keep it free of React/Electron so
 * every exclusion is testable and unsupported requests retain the sidecar.
 */
export function assessTsRuntimeAgentEligibility(input: {
  mode: string
  messages: readonly UnifiedMessage[]
  provider: ProviderConfig
  modelSource: unknown
  workspaceId: string
  workingDirectory?: string | null
  toolNames: readonly string[]
  hasPlan: boolean
  hasGoal: boolean
  hasSsh: boolean
  hasPlugin: boolean
  hasChannels: boolean
  hasTeam: boolean
  hasImages: boolean
  /** Main-compatible declarative HTTP extension names captured at submission. */
  extensionToolNames?: readonly string[]
}): TsRuntimeAgentEligibility {
  if (input.mode !== 'execute') return { eligible: false, reason: 'MODE_NOT_MIGRATED' }
  if (input.hasPlan) return { eligible: false, reason: 'PLAN_NOT_MIGRATED' }
  if (input.hasGoal) return { eligible: false, reason: 'GOAL_NOT_MIGRATED' }
  if (input.hasSsh) return { eligible: false, reason: 'SSH_NOT_MIGRATED' }
  if (input.hasPlugin) return { eligible: false, reason: 'PLUGIN_NOT_MIGRATED' }
  if (input.hasChannels) return { eligible: false, reason: 'CHANNELS_NOT_MIGRATED' }
  if (input.hasTeam) return { eligible: false, reason: 'TEAM_NOT_MIGRATED' }
  if (input.hasImages) return { eligible: false, reason: 'ATTACHMENTS_NOT_MIGRATED' }
  if (
    !supportsTsRuntimeAgentTools({
      toolNames: input.toolNames,
      workingDirectory: input.workingDirectory,
      extensionToolNames: input.extensionToolNames
    })
  )
    return { eligible: false, reason: 'TOOLS_NOT_MIGRATED' }

  let modelSource: ModelSource
  try {
    modelSource = parseModelSource(input.modelSource)
  } catch {
    return { eligible: false, reason: 'MODEL_SOURCE_NOT_MIGRATED' }
  }
  if (modelSource.kind !== 'local' && modelSource.workspaceId !== input.workspaceId)
    return { eligible: false, reason: 'WORKSPACE_MISMATCH' }

  const text = assessTsRuntimeTextEligibility({
    messages: input.messages,
    provider: input.provider,
    modelSource
  })
  return text.eligible ? { ...text, modelSource } : text
}
