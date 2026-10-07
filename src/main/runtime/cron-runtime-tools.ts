import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import {
  handleCronAdd,
  handleCronDelete,
  handleCronList,
  handleCronRemove,
  handleCronUpdate,
  type CronAddArgs,
  type CronUpdateArgs
} from '../ipc/cron-handlers'

type Schedule = CronAddArgs['schedule']
type CronToolName =
  | 'CronAdd'
  | 'CronCreate'
  | 'CronUpdate'
  | 'CronRemove'
  | 'CronDelete'
  | 'CronList'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new RuntimeError('INVALID_TOOL_INPUT')
}

function boundedText(value: unknown, maximum: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value.trim()
}

function schedule(value: unknown): Schedule {
  const input = object(value)
  only(input, ['kind', 'at', 'every', 'expr', 'tz'])
  if (input.kind !== 'at' && input.kind !== 'every' && input.kind !== 'cron')
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    input.at !== undefined &&
    !(typeof input.at === 'number' && Number.isFinite(input.at)) &&
    !(typeof input.at === 'string' && input.at.length <= 100)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    input.every !== undefined &&
    (typeof input.every !== 'number' || !Number.isFinite(input.every))
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const expr = input.expr === undefined ? undefined : boundedText(input.expr, 128)
  const tz = input.tz === undefined ? undefined : boundedText(input.tz, 128)
  let at = input.at as string | number | undefined
  if (typeof at === 'string') {
    const relative = /^\+(\d{1,6})(s|m|h|d)$/i.exec(at.trim())
    if (relative) {
      const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
        relative[2].toLowerCase() as 's' | 'm' | 'h' | 'd'
      ]
      at = Date.now() + Number(relative[1]) * multiplier
    }
  }
  return {
    kind: input.kind,
    ...(at !== undefined ? { at } : {}),
    ...(input.every !== undefined ? { every: input.every as number } : {}),
    ...(expr ? { expr } : {}),
    ...(tz ? { tz } : {})
  }
}

function addInput(
  value: unknown
): Omit<CronAddArgs, 'workspaceId' | 'sessionId' | 'workingFolder'> {
  const input = object(value)
  only(input, [
    'name',
    'schedule',
    'prompt',
    'agentId',
    'model',
    'workingFolder',
    'deliveryMode',
    'deliveryTarget',
    'deleteAfterRun',
    'maxIterations',
    'pluginId',
    'pluginChatId'
  ])
  if (
    input.deliveryMode !== undefined &&
    input.deliveryMode !== 'desktop' &&
    input.deliveryMode !== 'session' &&
    input.deliveryMode !== 'none'
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (input.deleteAfterRun !== undefined && typeof input.deleteAfterRun !== 'boolean')
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    input.maxIterations !== undefined &&
    (!Number.isSafeInteger(input.maxIterations) ||
      (input.maxIterations as number) < 1 ||
      (input.maxIterations as number) > 100)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    name: boundedText(input.name, 256)!,
    schedule: schedule(input.schedule),
    prompt: boundedText(input.prompt, 32_000)!,
    ...(input.agentId !== undefined ? { agentId: boundedText(input.agentId, 128) } : {}),
    ...(input.model !== undefined ? { model: boundedText(input.model, 256) } : {}),
    ...(input.deliveryMode !== undefined ? { deliveryMode: input.deliveryMode } : {}),
    ...(input.deliveryTarget !== undefined
      ? { deliveryTarget: boundedText(input.deliveryTarget, 256) }
      : {}),
    ...(input.deleteAfterRun !== undefined ? { deleteAfterRun: input.deleteAfterRun } : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations as number } : {}),
    ...(input.pluginId !== undefined ? { pluginId: boundedText(input.pluginId, 128) } : {}),
    ...(input.pluginChatId !== undefined
      ? { pluginChatId: boundedText(input.pluginChatId, 256) }
      : {})
  }
}

const cronAddSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 256 },
    schedule: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['at', 'every', 'cron'] },
        at: { type: ['string', 'number'] },
        every: { type: 'number' },
        expr: { type: 'string' },
        tz: { type: 'string' }
      },
      required: ['kind'],
      additionalProperties: false
    },
    prompt: { type: 'string', minLength: 1, maxLength: 32_000 },
    agentId: { type: 'string' },
    model: { type: 'string' },
    workingFolder: { type: 'string', description: 'Ignored; the current project folder is used.' },
    deliveryMode: { type: 'string', enum: ['desktop', 'session', 'none'] },
    deliveryTarget: { type: 'string' },
    deleteAfterRun: { type: 'boolean' },
    maxIterations: { type: 'integer', minimum: 1, maximum: 100 },
    pluginId: { type: 'string' },
    pluginChatId: { type: 'string' }
  },
  required: ['name', 'schedule', 'prompt'],
  additionalProperties: false
}

async function executeAdd(value: unknown, context: ToolContext): Promise<unknown> {
  const input = addInput(value)
  const result = await handleCronAdd({
    ...input,
    workspaceId: context.run.workspaceId,
    sessionId: context.run.sessionId,
    ...(context.run.workingDirectory ? { workingFolder: context.run.workingDirectory } : {})
  })
  return unwrap(result)
}

function patchInput(value: unknown): { jobId: string; patch: CronUpdateArgs['patch'] } {
  const input = object(value)
  only(input, ['jobId', 'patch'])
  const jobId = boundedText(input.jobId, 256)!
  const patch = object(input.patch)
  const fields = [
    'name',
    'schedule',
    'prompt',
    'agentId',
    'model',
    'deliveryMode',
    'deliveryTarget',
    'enabled',
    'deleteAfterRun',
    'maxIterations'
  ] as const
  only(patch, fields)
  if (!Object.keys(patch).length) throw new RuntimeError('INVALID_TOOL_INPUT')
  const normalized: Record<string, unknown> = {}
  for (const key of ['name', 'prompt', 'agentId', 'model', 'deliveryTarget'] as const) {
    if (patch[key] !== undefined)
      normalized[key] = boundedText(patch[key], key === 'prompt' ? 32_000 : 4096)
  }
  if (patch.schedule !== undefined) normalized.schedule = schedule(patch.schedule)
  if (patch.deliveryMode !== undefined) {
    if (!['desktop', 'session', 'none'].includes(String(patch.deliveryMode)))
      throw new RuntimeError('INVALID_TOOL_INPUT')
    normalized.deliveryMode = patch.deliveryMode
  }
  for (const key of ['enabled', 'deleteAfterRun'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean')
      throw new RuntimeError('INVALID_TOOL_INPUT')
    if (patch[key] !== undefined) normalized[key] = patch[key]
  }
  if (patch.maxIterations !== undefined) {
    if (
      !Number.isSafeInteger(patch.maxIterations) ||
      (patch.maxIterations as number) < 1 ||
      (patch.maxIterations as number) > 100
    )
      throw new RuntimeError('INVALID_TOOL_INPUT')
    normalized.maxIterations = patch.maxIterations
  }
  return { jobId, patch: normalized as CronUpdateArgs['patch'] }
}

function removeInput(value: unknown): { jobId: string } {
  const input = object(value)
  only(input, ['jobId', 'id'])
  return { jobId: boundedText(input.jobId ?? input.id, 256)! }
}

function unwrap(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { error?: unknown }).error === 'string'
  )
    throw new RuntimeError('CRON_OPERATION_FAILED')
  return value
}

function tool(
  name: CronToolName,
  description: string,
  inputSchema: Record<string, unknown>,
  validate: (input: unknown) => unknown,
  execute: (input: unknown, context: ToolContext) => Promise<unknown>,
  effect: 'read' | 'write'
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    effect,
    validate,
    resources: async (input, context) =>
      effect === 'read'
        ? []
        : [
            `cron:${context.run.workspaceId}:${(input as { jobId?: string }).jobId ?? 'collection'}`
          ],
    execute
  }
}

export function createCronRuntimeTools(): ToolDefinition[] {
  const add = (name: 'CronAdd' | 'CronCreate') =>
    tool(
      name,
      'Create a scheduled job in the current workspace. The Runtime binds its workspace, session, and project directory.',
      cronAddSchema,
      addInput,
      executeAdd,
      'write'
    )
  const updateSchema = {
    type: 'object',
    properties: { jobId: { type: 'string' }, patch: { type: 'object' } },
    required: ['jobId', 'patch'],
    additionalProperties: false
  }
  const removeSchema = {
    type: 'object',
    properties: { jobId: { type: 'string' }, id: { type: 'string' } },
    additionalProperties: false
  }
  return [
    add('CronAdd'),
    add('CronCreate'),
    tool(
      'CronUpdate',
      'Update a scheduled job in the current workspace.',
      updateSchema,
      patchInput,
      async (value, context) => {
        const input = patchInput(value)
        return unwrap(
          await handleCronUpdate({
            ...input,
            workspaceId: context.run.workspaceId,
            sessionId: context.run.sessionId
          })
        )
      },
      'write'
    ),
    tool(
      'CronRemove',
      'Disable and remove a scheduled job from the current workspace.',
      removeSchema,
      removeInput,
      async (value, context) => {
        const input = removeInput(value)
        return unwrap(
          await handleCronRemove({
            ...input,
            workspaceId: context.run.workspaceId,
            sessionId: context.run.sessionId
          })
        )
      },
      'write'
    ),
    tool(
      'CronDelete',
      'Delete a scheduled job from the current workspace.',
      removeSchema,
      removeInput,
      async (value, context) => {
        const input = removeInput(value)
        return unwrap(
          await handleCronDelete({
            ...input,
            workspaceId: context.run.workspaceId,
            sessionId: context.run.sessionId
          })
        )
      },
      'write'
    ),
    tool(
      'CronList',
      'List scheduled jobs for the current workspace and session.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      (value) => {
        only(object(value), [])
        return {}
      },
      async (_value, context) =>
        unwrap(
          await handleCronList({
            workspaceId: context.run.workspaceId,
            sessionId: context.run.sessionId
          })
        ),
      'read'
    )
  ]
}
