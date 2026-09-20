import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import type { ModelOptions } from '../../../../shared/runtime/model'
import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import type { RuntimeImage, RuntimeTextMessage } from '../../../../shared/runtime/contracts'
import {
  assessTsRuntimeTextEligibility,
  supportsTsRuntimeAgentTools
} from './ts-runtime-text-eligibility'

export type TsRuntimeAgentEligibility =
  | {
      eligible: true
      modelSource: ModelSource
      prompt: string
      promptImages: RuntimeImage[]
      history: RuntimeTextMessage[]
      modelOptions: ModelOptions
    }
  | { eligible: false; reason: string }

/**
 * Explicit migration gate for Execute mode. Keep it free of React/Electron so
 * every exclusion is testable and unsupported requests fail closed.
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
  sshConnectionId?: string | null
  hasPlugin: boolean
  hasChannels: boolean
  hasTeam: boolean
  /** Legacy UI hint; image blocks are now inspected by text eligibility. */
  hasImages: boolean
  /** Required when channel tools are exposed to an unattended TS run. */
  channelContext?: { pluginId: string; chatId: string; messageId?: string }
  /** Main-compatible declarative HTTP extension names captured at submission. */
  extensionToolNames?: readonly string[]
}): TsRuntimeAgentEligibility {
  if (input.mode !== 'execute') return { eligible: false, reason: 'MODE_NOT_MIGRATED' }
  // Plan persistence is now Main-owned by the TS runtime. Advanced plan-only
  // UI capabilities still remain explicit gates below through tool parity.
  if (input.hasSsh && !input.sshConnectionId?.trim())
    return { eligible: false, reason: 'SSH_NOT_MIGRATED' }
  if (input.hasPlugin && !hasValidChannelContext(input.channelContext))
    return { eligible: false, reason: 'PLUGIN_NOT_MIGRATED' }
  if (input.hasChannels && !hasValidChannelContext(input.channelContext))
    return { eligible: false, reason: 'CHANNELS_NOT_MIGRATED' }
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

function hasValidChannelContext(
  value: { pluginId: string; chatId: string; messageId?: string } | undefined
): boolean {
  return Boolean(value?.pluginId.trim() && value.chatId.trim())
}
