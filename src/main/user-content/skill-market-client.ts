const MARKET_ORIGIN = 'https://skills.ola.shop'
const MARKET_API = `${MARKET_ORIGIN}/api/v1`
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export interface MarketSkill {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  tags: string[]
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
  installCommand: string
}

export interface SkillMarketRequest {
  offset?: number
  limit?: number
  query?: string
  provider?: 'skillsmp'
  apiKey?: string
}

export interface SkillDownloadRequest {
  slug?: string
  name: string
  apiKey?: string
  downloadUrl?: string
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

export class SkillMarketClient {
  constructor(
    private readonly userAgent: string,
    private readonly fetcher: Fetcher = fetch
  ) {}

  async list(request: SkillMarketRequest): Promise<{ total: number; skills: MarketSkill[] }> {
    if (request.provider && request.provider !== 'skillsmp') return { total: 0, skills: [] }
    const limit = Math.min(Math.max(Math.floor(request.limit ?? 20), 1), 100)
    const offset = Math.max(Math.floor(request.offset ?? 0), 0)
    const params = new URLSearchParams({
      page: String(Math.floor(offset / limit) + 1),
      limit: String(limit),
      sortBy: 'popular'
    })
    if (request.query?.trim()) params.set('q', request.query.trim())
    try {
      const response = await this.fetcher(`${MARKET_API}/skills/search?${params}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(request.apiKey?.trim() ? { Authorization: `Bearer ${request.apiKey.trim()}` } : {})
        }
      })
      const length = response.headers.get('content-length')
      if (length && Number(length) > MAX_RESPONSE_BYTES)
        throw new Error('Skills marketplace response is too large')
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES)
        throw new Error('Skills marketplace response is too large')
      if (!response.ok) throw new Error(`Skills marketplace API ${response.status}`)
      return normalize(JSON.parse(body) as unknown)
    } catch {
      return { total: 0, skills: [] }
    }
  }

  async download(
    request: SkillDownloadRequest,
    temporaryDirectory: string
  ): Promise<{ tempPath: string; files: { path: string; content: string }[] }> {
    const slug = (request.slug ?? request.name).trim()
    if (!slug) throw new Error('Missing skill slug for marketplace download')
    const url = new URL(
      request.downloadUrl ?? `${MARKET_ORIGIN}/skills/${encodeURIComponent(slug)}/download`
    )
    if (
      url.protocol !== 'https:' ||
      url.origin !== MARKET_ORIGIN ||
      !url.pathname.startsWith('/skills/')
    ) {
      throw new Error('Skill download URL is not an allowed marketplace URL')
    }
    const response = await this.fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/zip, text/markdown;q=0.9, */*;q=0.8',
        'User-Agent': this.userAgent,
        ...(request.apiKey?.trim() ? { Authorization: `Bearer ${request.apiKey.trim()}` } : {})
      }
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!response.ok) throw new Error(`Skills marketplace download failed ${response.status}`)
    const type = response.headers.get('content-type')?.toLowerCase() ?? ''
    const disposition = response.headers.get('content-disposition')?.toLowerCase() ?? ''
    return await materializeSkillArchive({
      temporaryDirectory,
      slug,
      bytes,
      isZip: type.includes('application/zip') || disposition.includes('.zip')
    })
  }
}

function normalize(value: unknown): { total: number; skills: MarketSkill[] } {
  const root =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  if (root.success === false) throw new Error('Skills marketplace API returned failure')
  const data = Array.isArray(root.data) ? root.data : []
  const skills = data.map((raw, index) => {
    const item =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const slug = string(item.slug) || string(item.name) || `skill-${index}`
    const url = `${MARKET_ORIGIN}/skills/${encodeURIComponent(slug)}`
    return {
      id: string(item.id) || slug,
      slug,
      name: string(item.name) || slug,
      description: string(item.description),
      ...(string(item.category) ? { category: string(item.category) } : {}),
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      downloads:
        typeof item.downloads === 'number' && Number.isFinite(item.downloads) ? item.downloads : 0,
      ...(string(item.updatedAt) ? { updatedAt: string(item.updatedAt) } : {}),
      ...(string(item.filePath) ? { filePath: string(item.filePath) } : {}),
      url,
      downloadUrl: `${url}/download`,
      installCommand: `npx skills add ${slug}`
    }
  })
  return {
    total:
      typeof root.total === 'number' && Number.isFinite(root.total) ? root.total : skills.length,
    skills
  }
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
import { materializeSkillArchive } from './skill-archive'
