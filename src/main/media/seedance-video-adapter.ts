import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type { SharedProviderRecord } from '../../shared/provider-contract'
import {
  MEDIA_FILE_MAX_BYTES,
  type VideoGenerationRequest,
  type VideoTaskState
} from '../../shared/media-runtime'

export interface VideoProviderContext {
  provider: SharedProviderRecord
  request: VideoGenerationRequest
}

export interface VideoProviderStatus {
  state: VideoTaskState
  progress: number
  outputUrl?: string
  error?: string
}

function apiRoot(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) throw new Error('Video provider base URL is required')
  const url = new URL(normalized)
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))
  ) {
    throw new Error('Video provider API must use HTTPS')
  }
  return normalized.replace(/\/(chat\/completions|responses)$/, '')
}

function authorization(provider: SharedProviderRecord): Record<string, string> {
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) throw new Error('Video provider API key is missing')
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
}

async function readError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 800)
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string }
      message?: string
    }
    return (
      parsed.error?.message || parsed.error?.code || parsed.message || `HTTP ${response.status}`
    )
  } catch {
    return text || `HTTP ${response.status}`
  }
}

function promptWithOptions(request: VideoGenerationRequest): string {
  const flags: string[] = []
  if (request.aspectRatio) flags.push(`--ratio ${request.aspectRatio}`)
  if (request.durationSeconds) flags.push(`--dur ${request.durationSeconds}`)
  if (request.resolution) flags.push(`--resolution ${request.resolution}`)
  return flags.length ? `${request.prompt}  ${flags.join('  ')}` : request.prompt
}

export async function createSeedanceTask(
  context: VideoProviderContext,
  signal: AbortSignal
): Promise<string> {
  const { provider, request } = context
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: promptWithOptions(request) }
  ]
  for (const [url, role] of [
    [request.firstFrameUrl, 'first_frame'],
    [request.lastFrameUrl, 'last_frame']
  ] as const) {
    if (!url) continue
    if (!url.startsWith('data:image/') && !url.startsWith('https://')) {
      throw new Error('Seedance frame inputs must use an HTTPS or image data URL')
    }
    content.push({ type: 'image_url', image_url: { url }, role })
  }

  const response = await fetch(`${apiRoot(provider.baseUrl)}/contents/generations/tasks`, {
    method: 'POST',
    headers: authorization(provider),
    body: JSON.stringify({ model: request.model, content }),
    signal
  })
  if (!response.ok) throw new Error(`Video task creation failed: ${await readError(response)}`)
  const body = (await response.json()) as { id?: string }
  if (!body.id) throw new Error('Video provider returned no task identifier')
  return body.id
}

export async function getSeedanceTaskStatus(
  context: VideoProviderContext,
  remoteTaskId: string,
  signal: AbortSignal
): Promise<VideoProviderStatus> {
  const response = await fetch(
    `${apiRoot(context.provider.baseUrl)}/contents/generations/tasks/${encodeURIComponent(remoteTaskId)}`,
    { headers: authorization(context.provider), signal }
  )
  if (!response.ok) throw new Error(`Video status query failed: ${await readError(response)}`)
  const body = (await response.json()) as {
    status?: string
    content?: { video_url?: string }
    error?: { message?: string }
  }
  const state: VideoTaskState =
    body.status === 'succeeded'
      ? 'completed'
      : body.status === 'failed'
        ? 'failed'
        : body.status === 'cancelled'
          ? 'cancelled'
          : body.status === 'running'
            ? 'running'
            : 'queued'
  return {
    state,
    progress: state === 'completed' ? 100 : state === 'running' ? 50 : 0,
    outputUrl: body.content?.video_url,
    error: body.error?.message
  }
}

export async function cancelSeedanceTask(
  context: VideoProviderContext,
  remoteTaskId: string,
  signal: AbortSignal
): Promise<void> {
  const response = await fetch(
    `${apiRoot(context.provider.baseUrl)}/contents/generations/tasks/${encodeURIComponent(remoteTaskId)}`,
    { method: 'DELETE', headers: authorization(context.provider), signal }
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(`Video task cancellation failed: ${await readError(response)}`)
  }
}

function assertSafeDownloadUrl(rawUrl: string): URL {
  const url = new URL(rawUrl)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:') throw new Error('Video download must use HTTPS')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    net.isIP(hostname) !== 0
  ) {
    throw new Error('Video download host is not allowed')
  }
  return url
}

export async function downloadVideoResult(
  rawUrl: string,
  directory: string,
  taskId: string,
  signal: AbortSignal
): Promise<{ fileName: string; bytes: number; mediaType: string }> {
  let url = assertSafeDownloadUrl(rawUrl)
  let response: Response | undefined
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(url, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location || redirects === 3) throw new Error('Video download redirect limit exceeded')
    url = assertSafeDownloadUrl(new URL(location, url).toString())
  }
  if (!response) throw new Error('Video download failed before receiving a response')
  if (!response.ok || !response.body)
    throw new Error(`Video download failed: HTTP ${response.status}`)
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
  if (!['video/mp4', 'video/webm'].includes(mediaType)) {
    throw new Error(`Video download returned unsupported content type: ${mediaType || 'unknown'}`)
  }
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > MEDIA_FILE_MAX_BYTES) throw new Error('Video download exceeds size limit')

  await fs.mkdir(directory, { recursive: true })
  const extension = mediaType === 'video/webm' ? '.webm' : '.mp4'
  const fileName = `${taskId}${extension}`
  const targetPath = path.join(directory, fileName)
  const tempPath = `${targetPath}.tmp`
  const file = await fs.open(tempPath, 'w', 0o600)
  let bytes = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MEDIA_FILE_MAX_BYTES) throw new Error('Video download exceeds size limit')
      await file.write(value)
    }
    await file.sync()
    await file.close()
    await fs.rename(tempPath, targetPath)
  } catch (error) {
    await file.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true })
    throw error
  }
  return { fileName, bytes, mediaType }
}
