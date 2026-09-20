import { parseModelSource, type ModelSource } from './model-source'
import type { ModelOptions } from './model'

export const RUNTIME_PROTOCOL_VERSION = 1
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024
export const RUNTIME_CAPABILITIES = [
  'runs',
  'replay',
  'cancel',
  'interactions',
  'workspace-switch'
] as const
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number]
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_interaction'
  | 'waiting_capability'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])
export interface RunSpec {
  runId: string
  taskId: string
  requestId: string
  traceId: string
  sessionId: string
  /** Existing chat message receiving this run's projected output. */
  assistantMessageId?: string
  /** Main-validated channel target for the narrowly scoped plugin tools. */
  channelContext?: { pluginId: string; chatId: string; messageId?: string }
  /** Explicit team collaboration scope for the Team* tools. */
  teamContext?: { teamName: string; memberName?: string }
  workspaceId: string
  environmentId: string
  /** Explicit local execution root for this run; it is not a workspace identity. */
  workingDirectory?: string
  /** Main-owned SSH connection selected for remote tools; contains no credentials. */
  sshConnectionId?: string
  /** Explicit project-scoped extension activation snapshot for this run. */
  extensionIds?: string[]
  /** Main-owned ephemeral translation buffer capabilities for translation Agent runs. */
  translationContext?: {
    sourceLanguage: string
    targetLanguage: string
    fileRoot?: string
  }
  /**
   * Model-visible capability snapshot. An omitted list deliberately means no
   * tools; hosts must never grant ambient tools based on current UI state.
   */
  toolNames?: string[]
  /** Per-run loop budget. The host may impose a lower default, never a higher implicit limit. */
  maxTurns?: number
  /** Per-run cap across every model response; checked before any call executes. */
  maxToolCalls?: number
  modelSource: ModelSource
  /** Optional independent model binding for ImageGenerate; never falls back silently across resources. */
  imageModelSource?: ModelSource
  /** Public, per-run model behavior. Credentials and request headers are never accepted here. */
  modelOptions?: ModelOptions
  prompt: string
  /** Current-turn images that fit the bounded runtime frame contract. */
  promptImages?: RuntimeImage[]
  /** Prior textual turns, oldest first. The current user prompt is stored separately. */
  history?: RuntimeTextMessage[]
  unattended: boolean
}
export interface RuntimeTextMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
  images?: RuntimeImage[]
}
export interface RuntimeImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  data?: string
  url?: string
  /** Main-owned staged image; never a filesystem path supplied by the renderer. */
  assetId?: string
}
export interface RunRecord extends RunSpec {
  status: RunStatus
  seq: number
  createdAt: number
  updatedAt: number
}
/** Run lists are operational metadata; request context stays available only via an authorized snapshot. */
export type RunSummary = Omit<RunRecord, 'prompt' | 'promptImages' | 'history' | 'modelOptions'>

export interface RunEvent {
  runId: string
  workspaceId: string
  seq: number
  traceId: string
  type: string
  data: unknown
  timestamp: number
}
export type RuntimeInteractionKind = 'question' | 'tool-approval' | 'plan-approval'
export interface PendingRuntimeInteraction {
  runId: string
  workspaceId: string
  interactionId: string
  kind: RuntimeInteractionKind
  payload: unknown
  version?: string
  createdAt: number
}
export interface RunSnapshot {
  run: RunRecord
  events: RunEvent[]
  pendingInteractions: PendingRuntimeInteraction[]
}

export class RuntimeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RuntimeError'
  }
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    throw new RuntimeError('INVALID_RUN')
  return value
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new RuntimeError('INVALID_RUN')
  return value
}

function isSensitiveOverrideKey(key: string): boolean {
  return /(api[-_]?key|authorization|cookie|credential|password|secret|token)/i.test(key)
}

function parsePublicJsonValue(value: unknown, depth = 0, state = { nodes: 0 }): unknown {
  if (++state.nodes > 512 || depth > 8) throw new RuntimeError('INVALID_RUN')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => parsePublicJsonValue(item, depth + 1, state))
  if (!value || typeof value !== 'object') throw new RuntimeError('INVALID_RUN')
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
      isSensitiveOverrideKey(key) ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    )
      throw new RuntimeError('INVALID_RUN')
    result[key] = parsePublicJsonValue(item, depth + 1, state)
  }
  return result
}

function parsePublicBodyOverrides(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_RUN')
  const result = parsePublicJsonValue(value)
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new RuntimeError('INVALID_RUN')
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024)
    throw new RuntimeError('INVALID_RUN')
  return result as Record<string, unknown>
}

function parseOmitBodyKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) throw new RuntimeError('INVALID_RUN')
  const seen = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(item) || seen.has(item))
      throw new RuntimeError('INVALID_RUN')
    seen.add(item)
    return item
  })
}

const MAX_RUNTIME_IMAGES = 4
const MAX_RUNTIME_IMAGE_BYTES = 768 * 1024
const RUNTIME_IMAGE_TYPES = new Set<RuntimeImage['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])

function parseRuntimeImages(
  value: unknown,
  totalBytes: { value: number }
): RuntimeImage[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_IMAGES)
    throw new RuntimeError('INVALID_RUN')
  const images = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new RuntimeError('INVALID_RUN')
    const item = candidate as Record<string, unknown>
    if (
      Object.keys(item).some((key) => !['mimeType', 'data', 'url', 'assetId'].includes(key)) ||
      !RUNTIME_IMAGE_TYPES.has(item.mimeType as RuntimeImage['mimeType']) ||
      [item.data, item.url, item.assetId].filter((value) => value !== undefined).length !== 1
    )
      throw new RuntimeError('INVALID_RUN')
    const mimeType = item.mimeType as RuntimeImage['mimeType']
    if (item.data !== undefined) {
      if (typeof item.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))
        throw new RuntimeError('INVALID_RUN')
      totalBytes.value += new TextEncoder().encode(item.data).byteLength
      if (totalBytes.value > MAX_RUNTIME_IMAGE_BYTES) throw new RuntimeError('INVALID_RUN')
      return { mimeType, data: item.data }
    }
    if (item.url !== undefined) {
      if (typeof item.url !== 'string' || item.url.length > 8192 || !/^https:\/\//i.test(item.url))
        throw new RuntimeError('INVALID_RUN')
      totalBytes.value += new TextEncoder().encode(item.url).byteLength
      if (totalBytes.value > MAX_RUNTIME_IMAGE_BYTES) throw new RuntimeError('INVALID_RUN')
      return { mimeType, url: item.url }
    }
    if (typeof item.assetId !== 'string' || !/^[a-f0-9-]{36}$/.test(item.assetId))
      throw new RuntimeError('INVALID_RUN')
    return { mimeType, assetId: item.assetId }
  })
  return images.length ? images : undefined
}

function parseRunModelOptions(input: unknown): ModelOptions | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new RuntimeError('INVALID_RUN')
  const value = input as Record<string, unknown>
  const allowed = [
    'systemPrompt',
    'maxTokens',
    'temperature',
    'topP',
    'reasoningEffort',
    'thinking',
    'thinkingLevel',
    'enablePromptCache',
    'cacheTtl',
    'serviceTier',
    'promptCacheKey',
    'responsesSessionScope',
    'bodyOverrides',
    'omitBodyKeys'
  ]
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RuntimeError('INVALID_RUN')
  const thinking = value.thinking
  if (thinking !== undefined) {
    if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking))
      throw new RuntimeError('INVALID_RUN')
    const item = thinking as Record<string, unknown>
    const isEnabled =
      Object.keys(item).length === 2 &&
      item.type === 'enabled' &&
      Number.isSafeInteger(item.budgetTokens) &&
      (item.budgetTokens as number) >= 1024 &&
      (item.budgetTokens as number) <= 1_000_000
    const isSimple =
      Object.keys(item).length === 1 && (item.type === 'adaptive' || item.type === 'disabled')
    if (!isEnabled && !isSimple) throw new RuntimeError('INVALID_RUN')
  }
  if (value.enablePromptCache !== undefined && typeof value.enablePromptCache !== 'boolean')
    throw new RuntimeError('INVALID_RUN')
  if (value.cacheTtl !== undefined && value.cacheTtl !== '5m' && value.cacheTtl !== '1h')
    throw new RuntimeError('INVALID_RUN')
  const bodyOverrides = parsePublicBodyOverrides(value.bodyOverrides)
  const omitBodyKeys = parseOmitBodyKeys(value.omitBodyKeys)
  const result: ModelOptions = {
    ...(optionalText(value.systemPrompt, 128 * 1024)
      ? { systemPrompt: value.systemPrompt as string }
      : {}),
    ...(boundedNumber(value.maxTokens, 1, 2_000_000)
      ? { maxTokens: value.maxTokens as number }
      : {}),
    ...(boundedNumber(value.temperature, 0, 2) !== undefined
      ? { temperature: value.temperature as number }
      : {}),
    ...(boundedNumber(value.topP, 0, 1) !== undefined ? { topP: value.topP as number } : {}),
    ...(optionalText(value.reasoningEffort, 64)
      ? { reasoningEffort: value.reasoningEffort as string }
      : {}),
    ...(thinking ? { thinking: thinking as ModelOptions['thinking'] } : {}),
    ...(optionalText(value.thinkingLevel, 64)
      ? { thinkingLevel: value.thinkingLevel as string }
      : {}),
    ...(value.enablePromptCache !== undefined
      ? { enablePromptCache: value.enablePromptCache as boolean }
      : {}),
    ...(value.cacheTtl ? { cacheTtl: value.cacheTtl as '5m' | '1h' } : {}),
    ...(optionalText(value.serviceTier, 64) ? { serviceTier: value.serviceTier as string } : {}),
    ...(optionalText(value.promptCacheKey, 256)
      ? { promptCacheKey: value.promptCacheKey as string }
      : {}),
    ...(optionalText(value.responsesSessionScope, 256)
      ? { responsesSessionScope: value.responsesSessionScope as string }
      : {}),
    ...(bodyOverrides ? { bodyOverrides } : {}),
    ...(omitBodyKeys ? { omitBodyKeys } : {})
  }
  return Object.keys(result).length ? result : undefined
}

export function parseRunSpec(input: unknown): RunSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new RuntimeError('INVALID_RUN')
  const value = input as Record<string, unknown>
  const allowed = [
    'runId',
    'taskId',
    'requestId',
    'traceId',
    'sessionId',
    'assistantMessageId',
    'channelContext',
    'teamContext',
    'workspaceId',
    'environmentId',
    'workingDirectory',
    'sshConnectionId',
    'extensionIds',
    'translationContext',
    'toolNames',
    'maxTurns',
    'maxToolCalls',
    'modelSource',
    'imageModelSource',
    'modelOptions',
    'prompt',
    'promptImages',
    'history',
    'unattended'
  ]
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RuntimeError('INVALID_RUN')
  for (const field of [
    'runId',
    'taskId',
    'requestId',
    'traceId',
    'sessionId',
    'workspaceId',
    'environmentId'
  ]) {
    const item = value[field]
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > 256 ||
      Array.from(item).some((character) => character.charCodeAt(0) < 32)
    )
      throw new RuntimeError('INVALID_RUN')
  }
  const assistantMessageId = optionalText(value.assistantMessageId, 256)
  let channelContext: RunSpec['channelContext']
  if (value.channelContext !== undefined) {
    if (
      !value.channelContext ||
      typeof value.channelContext !== 'object' ||
      Array.isArray(value.channelContext)
    )
      throw new RuntimeError('INVALID_RUN')
    const channel = value.channelContext as Record<string, unknown>
    if (
      Object.keys(channel).some((key) => !['pluginId', 'chatId', 'messageId'].includes(key)) ||
      typeof channel.pluginId !== 'string' ||
      typeof channel.chatId !== 'string' ||
      !channel.pluginId.trim() ||
      !channel.chatId.trim() ||
      channel.pluginId.length > 256 ||
      channel.chatId.length > 512
    )
      throw new RuntimeError('INVALID_RUN')
    const messageId = optionalText(channel.messageId, 512)
    channelContext = {
      pluginId: channel.pluginId.trim(),
      chatId: channel.chatId.trim(),
      ...(messageId ? { messageId } : {})
    }
  }
  let teamContext: RunSpec['teamContext']
  if (value.teamContext !== undefined) {
    if (
      !value.teamContext ||
      typeof value.teamContext !== 'object' ||
      Array.isArray(value.teamContext)
    )
      throw new RuntimeError('INVALID_RUN')
    const team = value.teamContext as Record<string, unknown>
    if (
      Object.keys(team).some((key) => !['teamName', 'memberName'].includes(key)) ||
      typeof team.teamName !== 'string' ||
      !team.teamName.trim() ||
      team.teamName.length > 128
    )
      throw new RuntimeError('INVALID_RUN')
    const memberName = optionalText(team.memberName, 128)
    teamContext = {
      teamName: team.teamName.trim(),
      ...(memberName ? { memberName: memberName.trim() } : {})
    }
  }
  const workingDirectory = optionalText(value.workingDirectory, 4096)
  if (workingDirectory && value.environmentId !== 'local') throw new RuntimeError('INVALID_RUN')
  const sshConnectionId = optionalText(value.sshConnectionId, 256)
  if (sshConnectionId && value.environmentId !== 'local') throw new RuntimeError('INVALID_RUN')
  let extensionIds: string[] | undefined
  if (value.extensionIds !== undefined) {
    if (!Array.isArray(value.extensionIds) || value.extensionIds.length > 64)
      throw new RuntimeError('INVALID_RUN')
    const seen = new Set<string>()
    extensionIds = value.extensionIds.map((item) => {
      if (typeof item !== 'string') throw new RuntimeError('INVALID_RUN')
      const id = item.trim().toLowerCase()
      if (!/^[a-z0-9_-]{2,64}$/.test(id) || seen.has(id)) throw new RuntimeError('INVALID_RUN')
      seen.add(id)
      return id
    })
  }
  let translationContext: RunSpec['translationContext']
  if (value.translationContext !== undefined) {
    if (
      !value.translationContext ||
      typeof value.translationContext !== 'object' ||
      Array.isArray(value.translationContext)
    )
      throw new RuntimeError('INVALID_RUN')
    const translation = value.translationContext as Record<string, unknown>
    if (
      Object.keys(translation).some(
        (key) => !['sourceLanguage', 'targetLanguage', 'fileRoot'].includes(key)
      ) ||
      typeof translation.sourceLanguage !== 'string' ||
      typeof translation.targetLanguage !== 'string' ||
      !translation.sourceLanguage.trim() ||
      !translation.targetLanguage.trim()
    )
      throw new RuntimeError('INVALID_RUN')
    const fileRoot = optionalText(translation.fileRoot, 4096)
    translationContext = {
      sourceLanguage: translation.sourceLanguage.trim().slice(0, 128),
      targetLanguage: translation.targetLanguage.trim().slice(0, 128),
      ...(fileRoot ? { fileRoot } : {})
    }
  }
  let toolNames: string[] | undefined
  if (value.toolNames !== undefined) {
    if (!Array.isArray(value.toolNames) || value.toolNames.length > 128)
      throw new RuntimeError('INVALID_RUN')
    const seen = new Set<string>()
    toolNames = value.toolNames.map((item) => {
      if (typeof item !== 'string') throw new RuntimeError('INVALID_RUN')
      const name = item.trim()
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(name) || seen.has(name))
        throw new RuntimeError('INVALID_RUN')
      seen.add(name)
      return name
    })
  }
  const maxTurns = boundedNumber(value.maxTurns, 1, 128)
  const maxToolCalls = boundedNumber(value.maxToolCalls, 1, 512)
  if (maxTurns !== undefined && !Number.isSafeInteger(maxTurns))
    throw new RuntimeError('INVALID_RUN')
  if (maxToolCalls !== undefined && !Number.isSafeInteger(maxToolCalls))
    throw new RuntimeError('INVALID_RUN')
  if (
    typeof value.prompt !== 'string' ||
    (!value.prompt.trim() && value.promptImages === undefined) ||
    new TextEncoder().encode(JSON.stringify(value.prompt)).byteLength > 128 * 1024 ||
    typeof value.unattended !== 'boolean'
  )
    throw new RuntimeError('INVALID_RUN')
  const imageBytes = { value: 0 }
  const promptImages = parseRuntimeImages(value.promptImages, imageBytes)
  let history: RuntimeTextMessage[] | undefined
  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > 128)
      throw new RuntimeError('INVALID_RUN')
    let bytes = 0
    history = value.history.map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new RuntimeError('INVALID_RUN')
      const item = message as Record<string, unknown>
      if (
        (Object.keys(item).length !== 2 && Object.keys(item).length !== 3) ||
        !['system', 'user', 'assistant'].includes(item.role as string) ||
        typeof item.text !== 'string' ||
        (!item.text.trim() && item.images === undefined)
      )
        throw new RuntimeError('INVALID_RUN')
      bytes += new TextEncoder().encode(item.text).byteLength
      if (bytes > 512 * 1024) throw new RuntimeError('INVALID_RUN')
      const images = parseRuntimeImages(item.images, imageBytes)
      return {
        role: item.role as RuntimeTextMessage['role'],
        text: item.text,
        ...(images ? { images } : {})
      }
    })
  }
  const modelSource = parseModelSource(value.modelSource)
  const imageModelSource =
    value.imageModelSource === undefined ? undefined : parseModelSource(value.imageModelSource)
  const modelOptions = parseRunModelOptions(value.modelOptions)
  if (modelSource.kind !== 'local' && modelSource.workspaceId !== value.workspaceId)
    throw new RuntimeError('WORKSPACE_MISMATCH')
  if (
    imageModelSource &&
    imageModelSource.kind !== 'local' &&
    imageModelSource.workspaceId !== value.workspaceId
  )
    throw new RuntimeError('WORKSPACE_MISMATCH')
  return {
    runId: value.runId as string,
    taskId: value.taskId as string,
    requestId: value.requestId as string,
    traceId: value.traceId as string,
    sessionId: value.sessionId as string,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(channelContext ? { channelContext } : {}),
    ...(teamContext ? { teamContext } : {}),
    workspaceId: value.workspaceId as string,
    environmentId: value.environmentId as string,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(sshConnectionId ? { sshConnectionId } : {}),
    ...(extensionIds?.length ? { extensionIds } : {}),
    ...(translationContext ? { translationContext } : {}),
    ...(toolNames?.length ? { toolNames } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    modelSource,
    ...(imageModelSource ? { imageModelSource } : {}),
    ...(modelOptions ? { modelOptions } : {}),
    prompt: value.prompt,
    ...(promptImages ? { promptImages } : {}),
    ...(history?.length ? { history } : {}),
    unattended: value.unattended
  }
}
