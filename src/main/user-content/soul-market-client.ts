import {
  normalizeSoulCategories,
  normalizeSoulMarketResponse,
  SOUL_FALLBACK_CATEGORIES,
  SOUL_MARKET_API_ORIGIN,
  type SoulCategory,
  type SoulMarketItem,
  validateSoulDownloadUrl
} from './soul-market-contract'

const MAX_SOUL_DOWNLOAD_BYTES = 2 * 1024 * 1024

type SoulMarketFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface SoulMarketListRequest {
  query?: string
  category?: string
  offset?: number
  limit?: number
  sortBy?: 'recent' | 'name'
  apiKey?: string
}

export interface SoulMarketDownloadRequest {
  slug?: string
  downloadUrl?: string
  apiKey?: string
}

export interface SoulMarketClientOptions {
  fetch?: SoulMarketFetch
  userAgent: string
}

export class SoulMarketClient {
  private readonly fetcher: SoulMarketFetch

  constructor(private readonly options: SoulMarketClientOptions) {
    this.fetcher = options.fetch ?? fetch
  }

  async list(
    request: SoulMarketListRequest = {}
  ): Promise<{ total: number; souls: SoulMarketItem[] }> {
    const limit = normalizeLimit(request.limit)
    const offset = normalizeOffset(request.offset)
    const params = new URLSearchParams({
      page: String(Math.floor(offset / limit) + 1),
      limit: String(limit),
      sortBy: request.sortBy === 'name' ? 'name' : 'recent'
    })
    addParam(params, 'q', request.query)
    addParam(params, 'category', request.category)

    const body = await this.requestText(
      `${SOUL_MARKET_API_ORIGIN}/souls/search?${params}`,
      request.apiKey
    )
    return normalizeSoulMarketResponse(parseJson(body, 'SOUL marketplace search response'))
  }

  async categories(apiKey?: string): Promise<SoulCategory[]> {
    try {
      const body = await this.requestText(`${SOUL_MARKET_API_ORIGIN}/souls/categories`, apiKey)
      return normalizeSoulCategories(parseJson(body, 'SOUL marketplace categories response'))
    } catch {
      return SOUL_FALLBACK_CATEGORIES
    }
  }

  async download(request: SoulMarketDownloadRequest): Promise<string> {
    const slug = request.slug?.trim()
    if (!slug) throw new Error('Missing SOUL slug for marketplace download')

    const url = request.downloadUrl?.trim()
      ? validateSoulDownloadUrl(request.downloadUrl.trim())
      : new URL(`${SOUL_MARKET_API_ORIGIN}/souls/${encodeURIComponent(slug)}/download`)
    return await this.requestText(url, request.apiKey, 'text/markdown, text/plain;q=0.9, */*;q=0.8')
  }

  private async requestText(
    url: string | URL,
    apiKey?: string,
    accept = 'application/json'
  ): Promise<string> {
    const response = await this.fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: accept,
        'User-Agent': this.options.userAgent,
        ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {})
      }
    })
    const headerLength = response.headers.get('content-length')
    if (headerLength && Number(headerLength) > MAX_SOUL_DOWNLOAD_BYTES) {
      throw new Error('SOUL marketplace response exceeds the maximum allowed size')
    }
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_SOUL_DOWNLOAD_BYTES) {
      throw new Error('SOUL marketplace response exceeds the maximum allowed size')
    }
    if (!response.ok) {
      throw new Error(`SOUL marketplace API ${response.status}: ${extractErrorDetail(body)}`)
    }
    return body
  }
}

function normalizeLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 100)
    : 20
}

function normalizeOffset(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function addParam(params: URLSearchParams, name: string, value: string | undefined): void {
  const trimmed = value?.trim()
  if (trimmed) params.set(name, trimmed)
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${source} is not valid JSON`)
  }
}

function extractErrorDetail(body: string): string {
  if (!body.trim()) return 'Unknown error'
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }
    const error = parsed.error
    const message = typeof error?.message === 'string' ? error.message.trim() : ''
    const code = typeof error?.code === 'string' ? error.code.trim() : ''
    if (message && code) return `${code}: ${message}`
    if (message) return message
  } catch {
    // Preserve the response body below when it is not structured API JSON.
  }
  return body.trim().slice(0, 1_024)
}
