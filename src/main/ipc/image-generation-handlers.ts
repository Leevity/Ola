import { registerMessagePackHandler } from './messagepack-handler'

type ImageGenerationArgs = {
  provider: {
    baseUrl?: string
    apiKey?: string
    model?: string
    requestOverrides?: { headers?: Record<string, string>; body?: Record<string, unknown> }
  }
  prompt: string
  count?: number
}

type ImageGenerationResult = {
  sourceType: 'base64'
  data: string
  mediaType: string
}

export function registerImageGenerationHandlers(): void {
  registerMessagePackHandler<ImageGenerationArgs>('image:generate', async (args) => {
    const provider = args?.provider
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
    const count = Math.max(1, Math.min(args?.count ?? 1, 4))
    if (!provider?.baseUrl || !provider.apiKey || !provider.model || !prompt) {
      throw new Error('IMAGE_RUNTIME_INVALID_REQUEST')
    }
    const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '')
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.requestOverrides?.headers ?? {})
      },
      body: JSON.stringify({
        model: provider.model,
        prompt,
        n: count,
        response_format: 'b64_json',
        ...(provider.requestOverrides?.body ?? {})
      })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`IMAGE_RUNTIME_PROVIDER_FAILED_${response.status}: ${text.slice(0, 300)}`)
    }
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>
    }
    const results = (payload.data ?? [])
      .filter((item): item is { b64_json: string } => typeof item.b64_json === 'string')
      .map<ImageGenerationResult>((item) => ({
        sourceType: 'base64',
        data: item.b64_json,
        mediaType: 'image/png'
      }))
    if (results.length === 0) throw new Error('IMAGE_RUNTIME_EMPTY_RESULT')
    return results
  })
}
