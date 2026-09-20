import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import {
  resolveMainImageProviderModel,
  resolveMainProviderSecret
} from '../providers/provider-main-store'
import { loadManagedModelResources, openManagedModelRequest } from '../remote/account-client'
import { ensureGeneratedImagesDirectory } from '../lib/generated-image-path'
import { olaDataRoot } from '../lib/ola-data-root'

const MAX_PROMPT_LENGTH = 16 * 1024
const MAX_IMAGES = 4
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function validateInput(value: unknown): {
  prompt: string
  count: number
  size?: string
  quality?: string
} {
  const input = record(value)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new RuntimeError('INVALID_TOOL_INPUT')
  const count = input.count === undefined ? 1 : input.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_IMAGES)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const size = input.size === undefined ? undefined : String(input.size)
  const quality = input.quality === undefined ? undefined : String(input.quality)
  if (size !== undefined && !['auto', '1024x1024', '1024x1536', '1536x1024'].includes(size))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(quality))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { prompt, count, ...(size ? { size } : {}), ...(quality ? { quality } : {}) }
}

function responseFormat(input: { prompt: string; count: number; size?: string; quality?: string }) {
  return {
    prompt: input.prompt,
    n: input.count,
    response_format: 'b64_json',
    ...(input.size && input.size !== 'auto' ? { size: input.size } : {}),
    ...(input.quality && input.quality !== 'auto' ? { quality: input.quality } : {})
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
    throw new RuntimeError('IMAGE_RESPONSE_TOO_LARGE')
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new RuntimeError('IMAGE_RESPONSE_TOO_LARGE')
  const value: unknown = JSON.parse(new TextDecoder().decode(body))
  return record(value)
}

function imagePayload(value: Record<string, unknown>): Array<{ data: string; mediaType: string }> {
  if (!Array.isArray(value.data)) throw new RuntimeError('IMAGE_RESPONSE_INVALID')
  return value.data.map((item) => {
    const row = record(item)
    const data = typeof row.b64_json === 'string' ? row.b64_json.trim() : ''
    if (!data) throw new RuntimeError('IMAGE_RESPONSE_INVALID')
    return { data, mediaType: 'image/png' }
  })
}

async function requestImages(
  context: ToolContext,
  input: ReturnType<typeof validateInput>
): Promise<Array<{ data: string; mediaType: string }>> {
  const body = responseFormat(input)
  let response: Response
  const source = context.run.imageModelSource ?? context.run.modelSource
  if (source.kind === 'local') {
    const resolved = resolveMainImageProviderModel()
    if (!resolved) throw new RuntimeError('MODEL_UNAVAILABLE')
    const apiKey = await resolveMainProviderSecret(resolved.provider.id, resolved.provider.apiKey)
    if (!apiKey) throw new RuntimeError('MODEL_UNAVAILABLE')
    const model = resolved.model
    const modelType = model.type ?? resolved.provider.type
    if (!String(modelType).includes('image')) throw new RuntimeError('MODEL_UNAVAILABLE')
    response = await fetch(`${resolved.provider.baseUrl.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      redirect: 'error',
      signal: context.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: model.id, ...body })
    })
  } else {
    const resources = await loadManagedModelResources(context.run.workspaceId)
    const resource = resources.find(
      (value) =>
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).id === source.resourceId &&
        (value as Record<string, unknown>).enabled === true
    ) as Record<string, unknown> | undefined
    if (!resource || typeof resource.model !== 'string' || !resource.model)
      throw new RuntimeError('MODEL_UNAVAILABLE')
    response = await openManagedModelRequest({
      workspaceId: context.run.workspaceId,
      resourceId: source.resourceId,
      sessionId: context.run.sessionId,
      endpoint: 'images/generations',
      body: new TextEncoder().encode(JSON.stringify({ model: resource.model, ...body })),
      contentType: 'application/json',
      signal: context.signal
    })
  }
  if (!response.ok) throw new RuntimeError('IMAGE_PROVIDER_FAILED')
  return imagePayload(await responseJson(response))
}

export function createImageRuntimeTool(): ToolDefinition {
  return {
    name: 'ImageGenerate',
    description: 'Generate images with the configured image model and save them to this workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_LENGTH },
        count: { type: 'integer', minimum: 1, maximum: MAX_IMAGES },
        size: { type: 'string', enum: ['auto', '1024x1024', '1024x1536', '1536x1024'] },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    effect: 'write',
    validate: validateInput,
    resources: async (_input, context) => [`generated-images:${context.run.workspaceId}`],
    execute: async (rawInput, context) => {
      const input = rawInput as ReturnType<typeof validateInput>
      const images = await requestImages(context, input)
      const directory = ensureGeneratedImagesDirectory(olaDataRoot(), context.run.workspaceId)
      await mkdir(directory, { recursive: true })
      const saved: Array<{ filePath: string; mediaType: string }> = []
      for (const image of images.slice(0, input.count)) {
        const filePath = join(directory, `${context.run.runId}-${randomUUID()}.png`)
        await writeFile(filePath, Buffer.from(image.data, 'base64'), { mode: 0o600 })
        saved.push({ filePath, mediaType: image.mediaType })
      }
      return JSON.stringify({ __olaImageResult: true, images: saved })
    }
  }
}
