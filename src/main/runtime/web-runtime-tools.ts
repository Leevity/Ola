import { RuntimeError } from '../../shared/runtime/contracts'
import { WebFetchService, type WebFetchFormat } from '../web/web-fetch-service'
import { WebSearchService, type WebSearchProvider } from '../web/web-search-service'
import { getWebSearchSecretStore } from '../web/web-search-secret-store'
import { readPersistedSettingsState } from '../ipc/settings-handlers'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_URLS = 5
const MAX_URL_LENGTH = 2_048
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 256 * 1024
const WEB_SEARCH_PROVIDERS = new Set<WebSearchProvider>([
  'tavily',
  'searxng',
  'exa',
  'exa-mcp',
  'bocha',
  'zhipu',
  'google',
  'bing',
  'baidu'
])

type WebFetchInput = {
  urls: string[]
  format: WebFetchFormat
  timeout: number
}
type WebSearchInput = { query: string; maxResults: number; searchMode: 'web' | 'news' }
type WebSearchConfig = {
  enabled: boolean
  provider: WebSearchProvider
  maxResults: number
  timeout: number
}

function webSearchConfig(): WebSearchConfig {
  const settings = readPersistedSettingsState()
  const provider = settings.webSearchProvider
  return {
    enabled: settings.webSearchEnabled === true,
    provider:
      typeof provider === 'string' && WEB_SEARCH_PROVIDERS.has(provider as WebSearchProvider)
        ? (provider as WebSearchProvider)
        : 'tavily',
    maxResults:
      typeof settings.webSearchMaxResults === 'number'
        ? Math.max(1, Math.min(20, Math.floor(settings.webSearchMaxResults)))
        : 5,
    timeout:
      typeof settings.webSearchTimeout === 'number'
        ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(settings.webSearchTimeout)))
        : 30_000
  }
}

function searchInput(value: unknown): WebSearchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).some((key) => key !== 'query' && key !== 'maxResults' && key !== 'searchMode')
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const query = item.query
  const maxResults = item.maxResults ?? 5
  const searchMode = item.searchMode ?? 'web'
  if (
    typeof query !== 'string' ||
    !query.trim() ||
    query.length > 1_024 ||
    typeof maxResults !== 'number' ||
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 20 ||
    (searchMode !== 'web' && searchMode !== 'news')
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { query: query.trim(), maxResults, searchMode }
}

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function input(value: unknown): WebFetchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).some(
      (key) => key !== 'url' && key !== 'urls' && key !== 'format' && key !== 'timeout'
    )
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (item.url !== undefined && item.urls !== undefined)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const supplied = item.url === undefined ? item.urls : item.url
  const values = typeof supplied === 'string' ? [supplied] : supplied
  if (!Array.isArray(values) || !values.length || values.length > MAX_URLS)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const urls = values.map(validUrl)
  if (urls.some((url) => !url) || new Set(urls).size !== urls.length)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const format = item.format ?? 'markdown'
  const timeout = item.timeout ?? 30_000
  if (
    (format !== 'markdown' && format !== 'text' && format !== 'html') ||
    typeof timeout !== 'number' ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    timeout > MAX_TIMEOUT_MS
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { urls: urls as string[], format, timeout }
}

/** Main-owned network boundary for the TS Agent. No browser or credential object crosses it. */
export function createWebFetchRuntimeTool(
  service = new WebFetchService(),
  name = 'web_fetch'
): ToolDefinition {
  return {
    name,
    description: 'Fetch up to five public HTTP(S) pages and return bounded page content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_URLS },
        format: { type: 'string', enum: ['markdown', 'text', 'html'] },
        timeout: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS }
      },
      additionalProperties: false
    },
    effect: 'read',
    validate: input,
    resources: async () => [],
    execute: async (value, context) => {
      const request = value as WebFetchInput
      const result = await service.fetch({
        urls: request.urls,
        format: request.format,
        timeout: request.timeout,
        signal: context.signal
      })
      context.signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
        throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
      return result
    }
  }
}

/** Resolves all search configuration and its key inside Main for each TS Agent call. */
export function createWebSearchRuntimeTool(input?: {
  service?: Pick<WebSearchService, 'search'>
  secrets?: { get(): Promise<string> }
  config?: () => WebSearchConfig
  name?: string
}): ToolDefinition {
  const service = input?.service ?? new WebSearchService()
  const secrets = input?.secrets
  const config = input?.config ?? webSearchConfig
  return {
    name: input?.name ?? 'web_search',
    description: 'Search the web using the Main-configured provider and return bounded results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20 },
        searchMode: { type: 'string', enum: ['web', 'news'] }
      },
      required: ['query'],
      additionalProperties: false
    },
    effect: 'read',
    validate: searchInput,
    resources: async () => [],
    execute: async (value, context) => {
      const request = value as WebSearchInput
      const configured = config()
      if (!configured.enabled) throw new RuntimeError('WEB_SEARCH_DISABLED')
      const apiKey = await (secrets ?? getWebSearchSecretStore()).get()
      const result = await service.search({
        query: request.query,
        provider: configured.provider,
        maxResults: Math.min(request.maxResults, configured.maxResults),
        searchMode: request.searchMode,
        timeout: configured.timeout,
        ...(apiKey ? { apiKey } : {}),
        signal: context.signal
      })
      context.signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
        throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
      return result
    }
  }
}

/**
 * The Agent protocol has long exposed these PascalCase names. Keeping them as
 * explicit aliases lets an existing transcript or provider replay move to the
 * TS runtime without silently rewriting model tool calls.
 */
export function createLegacyWebFetchRuntimeTool(service?: WebFetchService): ToolDefinition {
  return createWebFetchRuntimeTool(service, 'WebFetch')
}

export function createLegacyWebSearchRuntimeTool(input?: {
  service?: Pick<WebSearchService, 'search'>
  secrets?: { get(): Promise<string> }
  config?: () => WebSearchConfig
}): ToolDefinition {
  return createWebSearchRuntimeTool({ ...input, name: 'WebSearch' })
}
