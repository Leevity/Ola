export type WebFetchFormat = 'markdown' | 'text' | 'html'

export interface WebFetchRequest {
  url?: string
  urls?: string[] | string
  format?: WebFetchFormat
  timeout?: number
  signal?: AbortSignal
}

export interface WebFetchResult {
  url: string
  finalUrl?: string
  title?: string
  content: string
  format: WebFetchFormat
  error?: string
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** Main-owned WebFetch implementation with the legacy response contract. */
export class WebFetchService {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async fetch(input: WebFetchRequest): Promise<{
    results: WebFetchResult[]
    format: WebFetchFormat
    totalResults: number
  }> {
    const urls = readUrls(input)
    if (!urls.length) throw new Error('Web fetch requires a url or urls input')
    const format = normalizeFormat(input.format)
    const timeoutMs = clampTimeout(input.timeout)
    const results = await Promise.all(
      urls.map((url) => this.fetchUrl(url, format, timeoutMs, input.signal))
    )
    return {
      results,
      format,
      totalResults: results.filter((result) => !result.error).length
    }
  }

  private async fetchUrl(
    url: string,
    format: WebFetchFormat,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<WebFetchResult> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.requestWithRedirectLimit(url, controller.signal)
      const raw = await readResponseText(response, controller.signal)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const finalUrl = response.url || url
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      const looksHtml =
        contentType.includes('html') || /<html\b|<body\b|<main\b|<article\b/i.test(raw)
      if (!looksHtml) {
        return { url, finalUrl, content: format === 'html' ? raw : raw.trim(), format }
      }
      const title = stripHtml(extractTag(raw, 'title'))
      const content =
        format === 'html'
          ? raw
          : format === 'text'
            ? stripHtml(sanitizeHtml(extractPreferredContent(raw)))
            : htmlToMarkdown(raw, finalUrl)
      return { url, finalUrl, ...(title ? { title } : {}), content, format }
    } catch (error) {
      const message = controller.signal.aborted
        ? `Request timeout after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
      return { url, content: '', format, error: message }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async requestWithRedirectLimit(url: string, signal: AbortSignal): Promise<Response> {
    let target = url
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
      const response = await this.fetcher(target, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      if (!location) return response
      if (redirectCount === 5) throw new Error('Too many redirects')
      target = new URL(location, target).toString()
    }
    throw new Error('Too many redirects')
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

function readUrls(input: WebFetchRequest): string[] {
  const direct = input.url?.trim()
  if (direct) return [direct]
  const values = typeof input.urls === 'string' ? [input.urls] : (input.urls ?? [])
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function normalizeFormat(value: unknown): WebFetchFormat {
  return value === 'html' || value === 'text' ? value : 'markdown'
}

function clampTimeout(value: number | undefined): number {
  const candidate = Number.isFinite(value) ? Math.floor(value!) : DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, candidate))
}

function extractTag(html: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)?.[1] ?? ''
}

function extractPreferredContent(html: string): string {
  return extractTag(html, 'article') || extractTag(html, 'main') || extractTag(html, 'body') || html
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|button|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let value = sanitizeHtml(extractPreferredContent(html))
  value = value.replace(
    /<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, content) => `\n\n\`\`\`\n${decode(content).trim()}\n\`\`\`\n\n`
  )
  value = value.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, content) => `\n\n\`\`\`\n${stripHtml(content)}\n\`\`\`\n\n`
  )
  value = value.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, content) =>
      `\n\n${'#'.repeat(Number(level))} ${inlineMarkdown(content, baseUrl)}\n\n`
  )
  value = value.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, content) =>
      `\n\n${inlineMarkdown(content, baseUrl)
        .split('\n')
        .filter(Boolean)
        .map((line) => `> ${line.trim()}`)
        .join('\n')}\n\n`
  )
  value = value.replace(
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    (_, content) => `- ${inlineMarkdown(content, baseUrl)}\n`
  )
  value = value
    .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, '')
  value = value.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
  value = value.replace(
    /<(p|div|section|article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag, content) => `\n\n${inlineMarkdown(content, baseUrl)}\n\n`
  )
  return normalizeMarkdown(decode(value))
}

function inlineMarkdown(value: string, baseUrl: string): string {
  let result = value
  result = result.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => {
      const url = resolveUrl(href, baseUrl)
      return `[${stripHtml(label) || url}](${url})`
    }
  )
  result = result.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag, text) => `**${stripHtml(text)}**`
  )
  result = result.replace(
    /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag, text) => `*${stripHtml(text)}*`
  )
  result = result.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_, text) => `\`${stripHtml(text).replaceAll('`', '\\`')}\``
  )
  result = result.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  return normalizeInline(decode(result))
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

function stripHtml(value: string): string {
  return normalizeInline(
    decode(
      value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  )
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeInline(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}
