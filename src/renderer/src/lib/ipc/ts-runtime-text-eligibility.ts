import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import type { ModelOptions } from '../../../../shared/runtime/model'
import type { RuntimeImage, RuntimeTextMessage } from '../../../../shared/runtime/contracts'

export type TsRuntimeTextEligibility =
  | {
      eligible: true
      prompt: string
      promptImages: RuntimeImage[]
      history: RuntimeTextMessage[]
      modelOptions: ModelOptions
    }
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
export const TS_RUNTIME_CHANNEL_TOOL_NAMES = new Set([
  'PluginGetGroupMessages',
  'PluginGetCurrentChatMessages',
  'PluginSummarizeGroup',
  'PluginListGroups',
  'PluginSendMessage',
  'PluginReplyMessage',
  'FeishuListChatMembers',
  'FeishuSendImage',
  'FeishuSendFile',
  'FeishuSendAudio',
  'FeishuSendVideo',
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
const TS_RUNTIME_AGENT_TOOL_NAMES = new Set([
  ...TS_RUNTIME_READ_ONLY_TOOL_NAMES,
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Monitor',
  'Notify',
  'TaskList',
  'TaskGet',
  'TaskCreate',
  'TaskUpdate',
  'TaskDelete',
  'Task',
  'Skill',
  'Agent',
  'AskUserQuestion',
  'visualize_show_widget',
  'EnterPlanMode',
  'ExitPlanMode',
  'ImageGenerate',
  'get_goal',
  'create_goal',
  'update_goal',
  'CronAdd',
  'CronCreate',
  'CronUpdate',
  'CronRemove',
  'CronDelete',
  'CronList',
  'MemoryList',
  'MemoryRead',
  'MemorySearch',
  'BrowserNavigate',
  'BrowserGetContent',
  'BrowserScreenshot',
  'BrowserSnapshot',
  'BrowserClick',
  'BrowserType',
  'BrowserScroll',
  'TeamCreate',
  'SendMessage',
  'TeamStatus',
  'TeamDelete',
  'TeamTaskCreate',
  'TeamTaskUpdate',
  // Channel tools are Main-owned and workspace-authorized.
  ...TS_RUNTIME_CHANNEL_TOOL_NAMES
])
const TS_RUNTIME_LOCAL_AGENT_TOOL_NAMES = new Set([
  ...TS_RUNTIME_LOCAL_READ_TOOL_NAMES,
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Monitor'
])
const TS_RUNTIME_MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]{1,96}__[A-Za-z0-9_-]{1,96}$/

function isTsRuntimeAgentToolName(name: string): boolean {
  return TS_RUNTIME_AGENT_TOOL_NAMES.has(name) || TS_RUNTIME_MCP_TOOL_NAME.test(name)
}

/**
 * The staged agent path only accepts tools whose Main-owned TS definitions
 * are protocol-compatible with the Chat mode catalog. Unsupported tool sets
 * fail closed until their Main-owned TS contract is available.
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
 * The TS bridge preserves plain text plus bounded image content. Rich blocks,
 * tool transcripts, oversized images and provider-specific features fail closed
 * until they have an equivalent runtime contract.
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
  const requestOverrideOptions = projectRequestOverrides(input.provider.requestOverrides)
  const responsesSessionScope = projectResponsesSessionScope(input.provider.responsesSessionScope)
  if (
    requestOverrideOptions === null ||
    responsesSessionScope === null ||
    input.provider.responsesImageGeneration ||
    input.provider.computerUseEnabled ||
    input.provider.instructionsPrompt ||
    input.provider.accountId
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
  // Background memory/context services may persist a system reminder after the
  // submitted user turn. Treat those reminders as preceding turn context for
  // the runtime projection; assistant/tool tails still fail closed because
  // they may represent an incomplete tool round-trip.
  let currentUserIndex = -1
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index].role === 'user') {
      currentUserIndex = index
      break
    }
  }
  const current = currentUserIndex >= 0 ? input.messages[currentUserIndex] : undefined
  const trailingContext = input.messages.slice(currentUserIndex + 1)
  if (!current || trailingContext.some((message) => message.role !== 'system'))
    return { eligible: false, reason: 'CURRENT_PROMPT_NOT_MIGRATED' }
  const currentContent = extractRuntimeContent(current.content)
  if (!currentContent || (!currentContent.text && currentContent.images.length === 0))
    return { eligible: false, reason: 'CURRENT_PROMPT_NOT_MIGRATED' }
  const history: RuntimeTextMessage[] = []
  const historyMessages = [...input.messages.slice(0, currentUserIndex), ...trailingContext]
  for (const message of historyMessages) {
    if (
      (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') ||
      !extractRuntimeContent(message.content)
    )
      return { eligible: false, reason: 'MESSAGE_CONTENT_NOT_MIGRATED' }
    const content = extractRuntimeContent(message.content)
    if (!content || (!content.text && content.images.length === 0))
      return { eligible: false, reason: 'MESSAGE_CONTENT_NOT_MIGRATED' }
    history.push({
      role: message.role,
      text: content.text,
      ...(content.images.length ? { images: content.images } : {})
    })
  }
  return {
    eligible: true,
    prompt: currentContent.text || '[User attached images without additional text.]',
    promptImages: currentContent.images,
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
      ...(responsesSessionScope ? { responsesSessionScope } : {}),
      ...(input.provider.thinkingConfig?.forceTemperature !== undefined &&
      input.provider.thinkingEnabled
        ? { temperature: input.provider.thinkingConfig.forceTemperature }
        : {}),
      ...thinkingOptions,
      ...(requestOverrideOptions?.bodyOverrides
        ? { bodyOverrides: requestOverrideOptions.bodyOverrides }
        : {}),
      ...(requestOverrideOptions?.omitBodyKeys
        ? { omitBodyKeys: requestOverrideOptions.omitBodyKeys }
        : {})
    }
  }
}

const MAX_TS_RUNTIME_IMAGE_COUNT = 4
const MAX_TS_RUNTIME_IMAGE_BYTES = 20 * 1024 * 1024

function extractRuntimeContent(
  content: UnifiedMessage['content']
): { text: string; images: RuntimeImage[] } | null {
  if (typeof content === 'string') return { text: content.trim(), images: [] }
  if (!Array.isArray(content)) return null
  const text: string[] = []
  const images: RuntimeImage[] = []
  let bytes = 0
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.trim()) text.push(block.text)
      continue
    }
    if (block.type !== 'image') return null
    if (images.length >= MAX_TS_RUNTIME_IMAGE_COUNT) return null
    const source = block.source
    if (source.type === 'base64' && source.data && typeof source.mediaType === 'string') {
      if (!isRuntimeImageType(source.mediaType)) return null
      bytes += new TextEncoder().encode(source.data).byteLength
      if (bytes > MAX_TS_RUNTIME_IMAGE_COUNT * MAX_TS_RUNTIME_IMAGE_BYTES) return null
      images.push({
        mimeType: source.mediaType,
        data: source.data
      })
      continue
    }
    if (
      source.type === 'url' &&
      typeof source.mediaType === 'string' &&
      typeof source.url === 'string' &&
      /^https:\/\//i.test(source.url)
    ) {
      if (!isRuntimeImageType(source.mediaType)) return null
      bytes += new TextEncoder().encode(source.url).byteLength
      if (bytes > MAX_TS_RUNTIME_COUNTED_URL_BYTES) return null
      images.push({ mimeType: source.mediaType, url: source.url })
      continue
    }
    return null
  }
  return { text: text.join('\n').trim(), images }
}

const MAX_TS_RUNTIME_COUNTED_URL_BYTES = 768 * 1024

function projectResponsesSessionScope(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127
    })
  )
    return null
  return value
}

function isRuntimeImageType(value: string): value is RuntimeImage['mimeType'] {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value)
}

function projectRequestOverrides(
  overrides: ProviderConfig['requestOverrides']
): { bodyOverrides?: Record<string, unknown>; omitBodyKeys?: string[] } | null {
  if (!overrides) return {}
  if (overrides.headers && Object.keys(overrides.headers).length) return null
  if (overrides.body !== undefined) {
    if (!overrides.body || typeof overrides.body !== 'object' || Array.isArray(overrides.body))
      return null
    let nodes = 0
    const inspect = (value: unknown, depth: number): boolean => {
      if (++nodes > 512 || depth > 8) return false
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
      if (typeof value === 'number') return Number.isFinite(value)
      if (Array.isArray(value)) return value.every((item) => inspect(item, depth + 1))
      if (!value || typeof value !== 'object') return false
      return Object.entries(value).every(([key, item]) => {
        if (
          !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
          /(api[-_]?key|authorization|cookie|credential|password|secret|token)/i.test(key)
        )
          return false
        return inspect(item, depth + 1)
      })
    }
    if (!inspect(overrides.body, 0)) return null
    if (new TextEncoder().encode(JSON.stringify(overrides.body)).byteLength > 64 * 1024) return null
  }
  if (overrides.omitBodyKeys) {
    if (
      overrides.omitBodyKeys.length > 64 ||
      overrides.omitBodyKeys.some((key) => !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key))
    )
      return null
  }
  return {
    ...(overrides.body ? { bodyOverrides: overrides.body } : {}),
    ...(overrides.omitBodyKeys?.length ? { omitBodyKeys: overrides.omitBodyKeys } : {})
  }
}

export function explicitTsRuntimeModelSource(input: {
  sessionModelSource?: ModelSource
  providerId?: string
  modelId: string
  managedWorkspaceKind?: 'ola-personal' | 'ola-team'
}): ModelSource | null {
  if (input.sessionModelSource) {
    try {
      return parseModelSource(input.sessionModelSource)
    } catch {
      return null
    }
  }
  if (!input.providerId) return null
  if (input.providerId.startsWith('ola-managed:')) {
    if (!input.managedWorkspaceKind) return null
    try {
      return parseModelSource({
        kind: input.managedWorkspaceKind,
        workspaceId: input.providerId.slice('ola-managed:'.length),
        resourceId: input.modelId
      })
    } catch {
      return null
    }
  }
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
