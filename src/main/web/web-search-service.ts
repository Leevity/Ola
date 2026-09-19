export type WebSearchProvider =
  | 'tavily'
  | 'searxng'
  | 'exa'
  | 'exa-mcp'
  | 'bocha'
  | 'zhipu'
  | 'google'
  | 'bing'
  | 'baidu'

export interface WebSearchRequest {
  query: string
  provider: WebSearchProvider
  maxResults?: number
  searchMode?: 'web' | 'news'
  apiKey?: string
  timeout?: number
  signal?: AbortSignal
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>
type SearchResult = {
  title: string
  url: string
  content: string
  score?: number
  publishedDate?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'

export class WebSearchService {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async search(input: WebSearchRequest): Promise<{
    results: SearchResult[]
    query: string
    provider: WebSearchProvider
    totalResults: number
  }> {
    const query = input.query?.trim()
    if (!query) throw new Error('Web search requires a query input')
    const maxResults = Math.max(1, Math.min(50, Math.floor(input.maxResults ?? 5)))
    const timeout = Math.max(
      1_000,
      Math.min(120_000, Math.floor(input.timeout ?? DEFAULT_TIMEOUT_MS))
    )
    const provider = input.provider
    if (provider === 'exa-mcp') {
      return {
        results: [
          {
            title: 'Exa MCP Search',
            url: '',
            content:
              'Exa MCP search requires an MCP server connection. Please configure an MCP server with Exa search capabilities.'
          }
        ],
        query,
        provider,
        totalResults: 0
      }
    }
    const result = await this.execute({ ...input, query, maxResults, timeout })
    return { results: result, query, provider, totalResults: result.length }
  }

  private async execute(
    input: Required<Pick<WebSearchRequest, 'query' | 'provider'>> &
      WebSearchRequest & { maxResults: number; timeout: number }
  ): Promise<SearchResult[]> {
    const encoded = encodeURIComponent(input.query)
    switch (input.provider) {
      case 'tavily':
        return this.jsonSearch(
          'https://api.tavily.com/search',
          {
            query: input.query,
            api_key: requiredKey(input, 'Tavily'),
            max_results: input.maxResults,
            search_mode: input.searchMode ?? 'web'
          },
          {},
          input,
          'content'
        )
      case 'searxng':
        return this.getJsonSearch(
          `https://searxng.org/search?q=${encoded}&format=json&limit=${input.maxResults}`,
          input,
          'content'
        )
      case 'exa':
        return this.jsonSearch(
          'https://api.exa.ai/search',
          {
            query: input.query,
            numResults: input.maxResults,
            searchMode: input.searchMode ?? 'web'
          },
          { 'x-api-key': requiredKey(input, 'Exa') },
          input,
          'snippet'
        )
      case 'bocha':
        return this.jsonSearch(
          'https://api.bocha.cn/search',
          { query: input.query, limit: input.maxResults },
          { Authorization: `Bearer ${requiredKey(input, 'Bocha')}` },
          input,
          'snippet'
        )
      case 'zhipu':
        return this.jsonSearch(
          'https://open.bigmodel.cn/api/paas/v4/tools/search',
          { prompt: input.query, max_results: input.maxResults },
          { Authorization: `Bearer ${requiredKey(input, 'Zhipu')}` },
          input,
          'content',
          'snippet'
        )
      case 'google':
        return this.htmlSearch(
          `https://www.google.com/search?hl=en&num=${input.maxResults}&gbv=1&q=${encoded}`,
          input,
          'google'
        )
      case 'bing':
        return this.htmlSearch(
          `https://www.bing.com/search?q=${encoded}&count=${input.maxResults}`,
          input,
          'bing'
        )
      case 'baidu':
        return this.htmlSearch(
          `https://www.baidu.com/s?wd=${encoded}&rn=${input.maxResults}`,
          input,
          'baidu'
        )
    }
    throw new Error(`Unsupported provider: ${input.provider}`)
  }

  private async getJsonSearch(
    url: string,
    input: { timeout: number; query: string; provider: WebSearchProvider; signal?: AbortSignal },
    contentKey: string
  ): Promise<SearchResult[]> {
    return parseResults(
      await this.request(url, { method: 'GET' }, input.timeout, input.signal),
      input.provider,
      contentKey
    )
  }

  private async jsonSearch(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    input: { timeout: number; query: string; provider: WebSearchProvider; signal?: AbortSignal },
    contentKey: string,
    fallback?: string
  ): Promise<SearchResult[]> {
    return parseResults(
      await this.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body)
        },
        input.timeout,
        input.signal
      ),
      input.provider,
      contentKey,
      fallback
    )
  }

  private async htmlSearch(
    url: string,
    input: {
      timeout: number
      maxResults: number
      provider: WebSearchProvider
      signal?: AbortSignal
    },
    provider: 'google' | 'bing' | 'baidu'
  ): Promise<SearchResult[]> {
    const html = await this.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': provider === 'baidu' ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache'
        }
      },
      input.timeout,
      input.signal
    )
    if (
      provider === 'google' &&
      /unusual traffic|detected unusual traffic|sorry\/index|To continue, please type/i.test(html)
    )
      throw new Error('Google blocked background crawling for this request')
    if (provider === 'baidu' && /百度安全验证|网络不给力|请输入验证码|verify/i.test(html))
      throw new Error('Baidu blocked background crawling for this request')
    const pattern =
      provider === 'google'
        ? /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>/gi
        : provider === 'bing'
          ? /<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
          : /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    const results: SearchResult[] = []
    const seen = new Set<string>()
    for (const match of html.matchAll(pattern)) {
      const title = stripHtml(match[2])
      const resultUrl = resolveResultUrl(provider, match[1])
      const dedupeKey = `${title}\u0000${resultUrl}`
      if (!title || !resultUrl || seen.has(dedupeKey) || results.length >= input.maxResults)
        continue
      seen.add(dedupeKey)
      results.push({ title, url: resultUrl, content: '' })
    }
    if (!results.length)
      throw new Error(
        `${provider[0].toUpperCase()}${provider.slice(1)} returned no parseable search results`
      )
    return results
  }

  private async request(
    url: string,
    init: RequestInit,
    timeout: number,
    signal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }
      })
      const body = await readResponseText(response, controller.signal)
      if (!response.ok) throw new Error(`${response.status} - ${body}`)
      return body
    } catch (error) {
      if (timedOut) throw new Error(`Request timeout after ${timeout}ms`)
      if (controller.signal.aborted) throw new Error('Request cancelled')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES)
    throw new Error('Response exceeds 2 MB limit')
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Response exceeds 2 MB limit')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function requiredKey(input: WebSearchRequest, provider: string): string {
  if (!input.apiKey?.trim()) throw new Error(`${provider} API key is required`)
  return input.apiKey.trim()
}

function parseResults(
  body: string,
  _provider: WebSearchProvider,
  contentKey: string,
  fallback?: string
): SearchResult[] {
  const root: unknown = JSON.parse(body)
  const items =
    root && typeof root === 'object' && Array.isArray((root as { results?: unknown }).results)
      ? (root as { results: unknown[] }).results
      : []
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const score = typeof row.score === 'number' ? row.score : undefined
    return [
      {
        title: text(row.title),
        url: text(row.url),
        content: text(row[contentKey]) || (fallback ? text(row[fallback]) : ''),
        ...(score === undefined ? {} : { score }),
        ...(text(row.published_date) || text(row.publishedDate)
          ? { publishedDate: text(row.published_date) || text(row.publishedDate) }
          : {})
      }
    ]
  })
}

function resolveResultUrl(provider: 'google' | 'bing' | 'baidu', raw: string): string {
  let value = decode(raw).replaceAll('\\u002F', '/').replaceAll('\\u003A', ':').trim()
  if (provider === 'google') {
    try {
      const url = new URL(value.startsWith('/url?') ? `https://www.google.com${value}` : value)
      return url.searchParams.get('q') || url.searchParams.get('url') || value
    } catch {
      return value
    }
  }
  if (value.startsWith('/'))
    value = `${provider === 'bing' ? 'https://www.bing.com' : 'https://www.baidu.com'}${value}`
  return value
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function stripHtml(value: string): string {
  return decode(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}
function decode(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}
