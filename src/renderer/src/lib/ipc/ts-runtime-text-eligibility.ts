import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import type { ModelOptions } from '../../../../shared/runtime/model'
import type { RuntimeTextMessage } from '../../../../shared/runtime/contracts'

export type TsRuntimeTextEligibility =
  | { eligible: true; prompt: string; history: RuntimeTextMessage[]; modelOptions: ModelOptions }
  | { eligible: false; reason: string }

const TS_RUNTIME_READ_ONLY_TOOL_NAMES = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch'
])
const TS_RUNTIME_LOCAL_READ_TOOL_NAMES = new Set(['Read', 'LS', 'Glob', 'Grep'])
const TS_RUNTIME_AGENT_TOOL_NAMES = new Set([
  ...TS_RUNTIME_READ_ONLY_TOOL_NAMES,
  'Write',
  'Edit',
  'Bash',
  'Notify',
  // Channel tools are Main-owned and workspace-authorized.
  'PluginGetGroupMessages',
  'PluginGetCurrentChatMessages',
  'PluginSummarizeGroup',
  'PluginListGroups',
  'PluginSendMessage',
  'PluginReplyMessage',
  'FeishuListChatMembers',
  'FeishuSendImage',
  'FeishuSendFile',
  'FeishuAtMember',
  'FeishuSendUrgent',
  'WeixinSendImage',
  'WeixinSendFile',
  'FeishuBitableListApps',
  'FeishuBitableListTables',
  'FeishuBitableListFields',
  'FeishuBitableGetRecords',
  'FeishuBitableCreateRecords',
  'FeishuBitableUpdateRecords',
  'FeishuBitableDeleteRecords'
])
const TS_RUNTIME_LOCAL_AGENT_TOOL_NAMES = new Set([
  ...TS_RUNTIME_LOCAL_READ_TOOL_NAMES,
  'Write',
  'Edit',
  'Bash'
])
const TS_RUNTIME_MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]{1,96}__[A-Za-z0-9_-]{1,96}$/

function isTsRuntimeAgentToolName(name: string): boolean {
  return TS_RUNTIME_AGENT_TOOL_NAMES.has(name) || TS_RUNTIME_MCP_TOOL_NAME.test(name)
}

/**
 * The staged agent path only accepts tools whose Main-owned TS definitions
 * are protocol-compatible with the Chat mode catalog. Callers use this before
 * opting in; every other tool stays on the existing sidecar path.
 */
export function supportsTsRuntimeReadOnlyTools(input: {
  toolNames: readonly string[]
  workingDirectory?: string | null
}): boolean {
  if (input.toolNames.some((name) => !TS_RUNTIME_READ_ONLY_TOOL_NAMES.has(name))) return false
  return (
    !input.toolNames.some((name) => TS_RUNTIME_LOCAL_READ_TOOL_NAMES.has(name)) ||
    Boolean(input.workingDirectory?.trim())
  )
}

/**
 * Execute-mode migration gate. Write and shell calls still pass through the
 * scheduler's persisted Main-side approval flow; this function only verifies
 * that an equivalent TS tool exists and has an explicit execution root.
 */
export function supportsTsRuntimeAgentTools(input: {
  toolNames: readonly string[]
  workingDirectory?: string | null
  /** Exact Main-owned declarative extension tool snapshot for this run. */
  extensionToolNames?: readonly string[]
}): boolean {
  const extensionTools = new Set(input.extensionToolNames ?? [])
  if (input.toolNames.some((name) => !isTsRuntimeAgentToolName(name) && !extensionTools.has(name)))
    return false
  return (
    !input.toolNames.some((name) => TS_RUNTIME_LOCAL_AGENT_TOOL_NAMES.has(name)) ||
    Boolean(input.workingDirectory?.trim())
  )
}

/**
 * The staged bridge must preserve the full provider request. It is deliberately
 * stricter than the TS runtime itself while legacy request construction still
 * owns rich content, image, unsupported tool, and provider-specific features.
 */
export function assessTsRuntimeTextEligibility(input: {
  messages: readonly UnifiedMessage[]
  modelSource: unknown
  provider: ProviderConfig
}): TsRuntimeTextEligibility {
  try {
    parseModelSource(input.modelSource)
  } catch {
    return { eligible: false, reason: 'MODEL_SOURCE_NOT_MIGRATED' }
  }
  if (!input.messages.length) return { eligible: false, reason: 'EMPTY_MESSAGES' }
  if (
    input.provider.requestOverrides ||
    input.provider.responsesImageGeneration ||
    input.provider.computerUseEnabled ||
    input.provider.instructionsPrompt ||
    input.provider.accountId ||
    input.provider.responsesSessionScope
  )
    return { eligible: false, reason: 'PROVIDER_OPTIONS_NOT_MIGRATED' }
  if (input.provider.thinkingEnabled && !input.provider.thinkingConfig)
    return { eligible: false, reason: 'PROVIDER_OPTIONS_NOT_MIGRATED' }
  const thinkingBody = input.provider.thinkingConfig?.bodyParams?.thinking
  const thinkingOptions = input.provider.thinkingConfig
    ? {
        ...(input.provider.thinkingEnabled
          ? { bodyOverrides: input.provider.thinkingConfig.bodyParams }
          : input.provider.thinkingConfig.disabledBodyParams
            ? { bodyOverrides: input.provider.thinkingConfig.disabledBodyParams }
            : {}),
        ...(input.provider.thinkingEnabled && thinkingBody && typeof thinkingBody === 'object'
          ? {
              thinking:
                (thinkingBody as { type?: unknown }).type === 'adaptive'
                  ? ({ type: 'adaptive' } as const)
                  : typeof (thinkingBody as { budget_tokens?: unknown }).budget_tokens === 'number'
                    ? {
                        type: 'enabled' as const,
                        budgetTokens: (thinkingBody as { budget_tokens: number }).budget_tokens
                      }
                    : undefined
            }
          : {})
      }
    : {}
  const current = input.messages.at(-1)
  if (
    !current ||
    current.role !== 'user' ||
    typeof current.content !== 'string' ||
    !current.content.trim()
  )
    return { eligible: false, reason: 'CURRENT_PROMPT_NOT_MIGRATED' }
  const history: RuntimeTextMessage[] = []
  for (const message of input.messages.slice(0, -1)) {
    if (
      (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      !message.content.trim()
    )
      return { eligible: false, reason: 'MESSAGE_CONTENT_NOT_MIGRATED' }
    history.push({ role: message.role, text: message.content })
  }
  return {
    eligible: true,
    prompt: current.content,
    history,
    modelOptions: {
      ...(input.provider.systemPrompt ? { systemPrompt: input.provider.systemPrompt } : {}),
      ...(input.provider.maxTokens ? { maxTokens: input.provider.maxTokens } : {}),
      ...(input.provider.temperature !== undefined
        ? { temperature: input.provider.temperature }
        : {}),
      ...(input.provider.reasoningEffort
        ? { reasoningEffort: input.provider.reasoningEffort }
        : {}),
      ...(input.provider.enablePromptCache !== undefined
        ? { enablePromptCache: input.provider.enablePromptCache }
        : {}),
      ...(input.provider.cacheTtl ? { cacheTtl: input.provider.cacheTtl } : {}),
      ...(input.provider.serviceTier ? { serviceTier: input.provider.serviceTier } : {}),
      ...(input.provider.promptCacheKey ? { promptCacheKey: input.provider.promptCacheKey } : {}),
      ...(input.provider.thinkingConfig?.forceTemperature !== undefined &&
      input.provider.thinkingEnabled
        ? { temperature: input.provider.thinkingConfig.forceTemperature }
        : {}),
      ...thinkingOptions
    }
  }
}

export function explicitTsRuntimeModelSource(input: {
  sessionModelSource?: ModelSource
  providerId?: string
  modelId: string
}): ModelSource | null {
  if (input.sessionModelSource) {
    try {
      return parseModelSource(input.sessionModelSource)
    } catch {
      return null
    }
  }
  if (!input.providerId || input.providerId.startsWith('ola-managed:')) return null
  try {
    return parseModelSource({
      kind: 'local',
      providerId: input.providerId,
      modelId: input.modelId
    })
  } catch {
    return null
  }
}
