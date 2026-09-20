import { nanoid } from 'nanoid'
import type {
  FinalOutcome,
  FinalOutcomeArtifact,
  FinalOutcomeStatus,
  ProviderConfig,
  UnifiedMessage
} from '../api/types'
import type { LoopEndReason, ToolCallState } from './types'
import { isTsRuntimeAvailable, streamTsRuntimeTextTurn } from '../ipc/ts-runtime-bridge'
import { resolveTsRuntimeModelBinding } from '../ipc/ts-runtime-model-binding'
import type { TaskProfile } from '../task-profile'

const MAX_CONTEXT_CHARS = 24_000
const MAX_TOOL_OUTPUT_CHARS = 1_200
const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie)/i
const SECRET_VALUE_PATTERN = /\b(bearer\s+\S+|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,})\b/gi

export interface FinalOutcomeInput {
  goal: string
  taskProfile?: TaskProfile
  loopEndReason: LoopEndReason
  toolCalls: ToolCallState[]
  durationMs: number
  error?: string | null
  providers: ProviderConfig[]
  signal?: AbortSignal
}

function redactText(value: string): string {
  return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]')
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[omitted]'
  if (typeof value === 'string') return redactText(value).slice(0, MAX_TOOL_OUTPUT_CHARS)
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : safeValue(item, depth + 1)
      ])
  )
}

function toolOutputText(toolCall: ToolCallState): string {
  if (!toolCall.output) return ''
  if (typeof toolCall.output === 'string')
    return redactText(toolCall.output).slice(0, MAX_TOOL_OUTPUT_CHARS)
  return toolCall.output
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT_CHARS)
}

export function resolveFinalOutcomeStatus(
  reason: LoopEndReason,
  toolCalls: ToolCallState[]
): FinalOutcomeStatus {
  if (reason === 'aborted') return 'canceled'
  if (reason === 'error') return 'failed'
  if (reason === 'max_iterations') return 'partial'
  return toolCalls.some((toolCall) => toolCall.status === 'error') ? 'failed' : 'completed'
}

function collectArtifacts(toolCalls: ToolCallState[]): FinalOutcomeArtifact[] {
  const artifacts = new Map<string, FinalOutcomeArtifact>()
  const pathKeys = ['path', 'file_path', 'filePath', 'output_path', 'outputPath', 'target']
  for (const toolCall of toolCalls) {
    for (const key of pathKeys) {
      const value = toolCall.input[key]
      if (typeof value !== 'string' || !value.trim()) continue
      const path = redactText(value.trim())
      artifacts.set(path, { label: path.split(/[\\/]/).pop() || path, path, kind: 'file' })
    }
    for (const match of toolOutputText(toolCall).matchAll(/https?:\/\/[^\s)\]}]+/g)) {
      const url = match[0]
      artifacts.set(url, { label: url, path: url, kind: 'url' })
    }
  }
  return [...artifacts.values()].slice(0, 20)
}

function completedLabel(toolCall: ToolCallState): string {
  const target =
    (typeof toolCall.input.path === 'string' && toolCall.input.path) ||
    (typeof toolCall.input.command === 'string' && toolCall.input.command) ||
    (typeof toolCall.input.query === 'string' && toolCall.input.query) ||
    ''
  return redactText(`${toolCall.name}${target ? `: ${target}` : ''}`).slice(0, 240)
}

export function buildDeterministicFinalOutcome(
  input: Omit<FinalOutcomeInput, 'providers' | 'signal'>,
  attemptCount: number
): FinalOutcome {
  const status = resolveFinalOutcomeStatus(input.loopEndReason, input.toolCalls)
  const completed = input.toolCalls.filter((toolCall) => toolCall.status === 'completed')
  const failed = input.toolCalls.filter((toolCall) => toolCall.status === 'error')
  const isChinese = /[\u3400-\u9fff]/.test(input.goal)
  const titles: Record<FinalOutcomeStatus, string> = isChinese
    ? {
        completed: '任务已完成',
        partial: '任务部分完成',
        failed: '任务执行失败',
        canceled: '任务已取消'
      }
    : {
        completed: 'Task completed',
        partial: 'Task partially completed',
        failed: 'Task failed',
        canceled: 'Task canceled'
      }
  const summary = isChinese
    ? status === 'completed'
      ? `已完成 ${completed.length} 个工具步骤。`
      : status === 'partial'
        ? `在达到最大执行轮次前完成了 ${completed.length} 个步骤，任务尚未全部完成。`
        : status === 'canceled'
          ? `任务已停止，停止前完成了 ${completed.length} 个步骤。`
          : `任务未成功完成，共有 ${failed.length} 个工具步骤失败。`
    : status === 'completed'
      ? `Completed ${completed.length} tool step${completed.length === 1 ? '' : 's'}.`
      : status === 'partial'
        ? `Completed ${completed.length} step${completed.length === 1 ? '' : 's'} before the run reached its iteration limit.`
        : status === 'canceled'
          ? `The run was stopped after ${completed.length} completed step${completed.length === 1 ? '' : 's'}.`
          : `The run did not complete successfully; ${failed.length} tool step${failed.length === 1 ? '' : 's'} failed.`

  return {
    taskProfile: input.taskProfile,
    status,
    title: titles[status],
    summary,
    completedItems: completed.slice(0, 12).map(completedLabel),
    artifacts: collectArtifacts(input.toolCalls),
    verification: [],
    warnings: [
      ...failed
        .slice(0, 8)
        .map((toolCall) => `${toolCall.name}: ${redactText(toolCall.error || 'Tool failed')}`),
      ...(input.error ? [redactText(input.error).slice(0, 800)] : []),
      ...(status === 'partial'
        ? [isChinese ? '执行已达到最大轮次。' : 'The run reached the maximum number of iterations.']
        : [])
    ],
    nextSteps:
      status === 'completed'
        ? []
        : status === 'canceled'
          ? [isChinese ? '准备好后可以重新开始该任务。' : 'Restart the task when you are ready.']
          : [
              isChinese
                ? '查看失败步骤，解决提示的问题后重试。'
                : 'Review the failed step and retry after resolving the reported issue.'
            ],
    source: 'deterministic',
    attemptCount
  }
}

function normalizeOutcome(
  value: unknown,
  expectedStatus: FinalOutcomeStatus,
  attemptCount: number,
  taskProfile?: TaskProfile
): FinalOutcome | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<FinalOutcome>
  if (typeof candidate.title !== 'string' || typeof candidate.summary !== 'string') return null
  const stringArray = (item: unknown): string[] =>
    Array.isArray(item)
      ? item.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
      : []
  const artifacts = Array.isArray(candidate.artifacts)
    ? candidate.artifacts
        .filter(
          (item): item is FinalOutcomeArtifact =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as FinalOutcomeArtifact).label === 'string'
        )
        .slice(0, 20)
    : []
  const verification = Array.isArray(candidate.verification)
    ? candidate.verification
        .filter((item) => !!item && typeof item === 'object' && typeof item.label === 'string')
        .map((item) => ({
          label: item.label,
          status: (item.status === 'passed' || item.status === 'failed'
            ? item.status
            : 'not_run') as 'passed' | 'failed' | 'not_run',
          ...(typeof item.detail === 'string' ? { detail: item.detail } : {})
        }))
        .slice(0, 20)
    : []
  return {
    taskProfile,
    status: expectedStatus,
    title: redactText(candidate.title).slice(0, 160),
    summary: redactText(candidate.summary).slice(0, 2_000),
    completedItems: stringArray(candidate.completedItems).map(redactText),
    artifacts: artifacts.map((artifact) => ({
      label: redactText(artifact.label),
      ...(artifact.path ? { path: redactText(artifact.path) } : {}),
      ...(artifact.kind ? { kind: artifact.kind } : {})
    })),
    verification,
    warnings: stringArray(candidate.warnings).map(redactText),
    nextSteps: stringArray(candidate.nextSteps).map(redactText),
    source: 'model',
    attemptCount
  }
}

function buildSummaryContext(input: FinalOutcomeInput): string {
  const tools = input.toolCalls.slice(-80).map((toolCall, index) => ({
    step: index + 1,
    name: toolCall.name,
    status: toolCall.status,
    durationMs:
      toolCall.startedAt && toolCall.completedAt
        ? Math.max(0, toolCall.completedAt - toolCall.startedAt)
        : undefined,
    input: safeValue(toolCall.input),
    output: toolOutputText(toolCall),
    error: toolCall.error ? redactText(toolCall.error).slice(0, 800) : undefined
  }))
  return JSON.stringify({
    goal: redactText(input.goal).slice(0, 4_000),
    taskProfile: input.taskProfile ?? 'work',
    loopEndReason: input.loopEndReason,
    durationMs: input.durationMs,
    error: input.error ? redactText(input.error).slice(0, 800) : undefined,
    tools
  }).slice(0, MAX_CONTEXT_CHARS)
}

async function runSummaryAttempt(
  input: FinalOutcomeInput,
  provider: ProviderConfig,
  attemptCount: number
): Promise<FinalOutcome | null> {
  const expectedStatus = resolveFinalOutcomeStatus(input.loopEndReason, input.toolCalls)
  const message: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    createdAt: Date.now(),
    content: `Create the final user-facing outcome from this execution record. Return JSON only.\n\n${buildSummaryContext(input)}`
  }
  const profileGuidance =
    input.taskProfile === 'code'
      ? 'For Code, emphasize changed files, commands, tests, builds, Git state and verification.'
      : 'For Work, emphasize conclusions, documents or other artifacts, sources, completed items and next steps.'
  const systemPrompt = `You summarize completed agent tool runs without using tools. Never invent work, files, verification, commits, URLs, or success. The required status is ${expectedStatus}. ${profileGuidance} Return exactly one JSON object with: status, title, summary, completedItems (string[]), artifacts ({label,path?,kind?}[]), verification ({label,status:passed|failed|not_run,detail?}[]), warnings (string[]), nextSteps (string[]). Keep it concise and use the user's language when evident from the goal.`
  const binding = resolveTsRuntimeModelBinding(provider)
  if (binding && (await isTsRuntimeAvailable())) {
    let tsResponse = ''
    for await (const event of streamTsRuntimeTextTurn({
      workspaceId: binding.workspaceId,
      sessionId: `final-outcome:${nanoid()}`,
      modelSource: binding.modelSource,
      modelOptions: {
        systemPrompt,
        ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
        thinking: { type: 'disabled' }
      },
      prompt: message.content as string,
      signal: input.signal
    })) {
      if (input.signal?.aborted) return null
      if (event.type === 'text_delta' && event.text) tsResponse += event.text
      else if (event.type === 'error') throw new Error(event.error?.message ?? 'summary failed')
      else if (event.type === 'loop_end') break
    }
    const match = tsResponse.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return normalizeOutcome(JSON.parse(match[0]), expectedStatus, attemptCount, input.taskProfile)
    } catch {
      return null
    }
  }
  // There is no production legacy-runtime fallback. A deterministic outcome is
  // safer than attempting to revive a removed execution path after TS failure.
  void provider
  void systemPrompt
  return null
}

/** Main model first, then fast/fallback configs, with a deterministic conclusion after three failures. */
export async function generateFinalOutcome(input: FinalOutcomeInput): Promise<FinalOutcome> {
  if (input.loopEndReason === 'aborted' || input.signal?.aborted) {
    return buildDeterministicFinalOutcome(input, 0)
  }
  const providers = input.providers.filter(Boolean).slice(0, 3)
  for (let index = 0; index < 3; index += 1) {
    const provider = providers[index] ?? providers.at(-1)
    if (!provider) break
    try {
      const result = await runSummaryAttempt(input, provider, index + 1)
      if (result) return result
    } catch (error) {
      console.warn(`[FinalOutcome] Summary attempt ${index + 1} failed`, error)
    }
  }
  return buildDeterministicFinalOutcome(input, 3)
}
