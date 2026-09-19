import { describe, expect, it } from 'vitest'
import { WebFetchService } from '../../src/main/web/web-fetch-service'
import {
  createWebFetchRuntimeTool,
  createWebSearchRuntimeTool,
  createLegacyWebFetchRuntimeTool,
  createLegacyWebSearchRuntimeTool
} from '../../src/main/runtime/web-runtime-tools'

describe('web fetch runtime tool', () => {
  it('passes only validated request data through the Main-owned fetch boundary', async () => {
    let requested = ''
    const service = new WebFetchService(async (url) => {
      requested = String(url)
      return new Response('hello', { status: 200 })
    })
    const tool = createWebFetchRuntimeTool(service)
    const result = await tool.execute(
      tool.validate({ url: 'https://example.test/docs', format: 'text', timeout: 1_000 }),
      { signal: new AbortController().signal } as never
    )
    expect(requested).toBe('https://example.test/docs')
    expect(result).toMatchObject({ totalResults: 1, format: 'text' })
  })

  it('rejects non-web URLs, duplicate URL forms, and caller-controlled extras', () => {
    const tool = createWebFetchRuntimeTool()
    expect(() => tool.validate({ url: 'file:///private/secret' })).toThrow('INVALID_TOOL_INPUT')
    expect(() =>
      tool.validate({ urls: ['https://example.test', 'https://example.test'], format: 'markdown' })
    ).toThrow('INVALID_TOOL_INPUT')
    expect(() =>
      tool.validate({ url: 'https://example.test', headers: { authorization: 'x' } })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('resolves the configured provider and secret only inside Main', async () => {
    let request: unknown
    const tool = createWebSearchRuntimeTool({
      service: {
        search: async (input) => {
          request = input
          return {
            query: input.query,
            provider: input.provider,
            totalResults: 1,
            results: [{ title: 'Result', url: 'https://example.test', content: 'text' }]
          }
        }
      },
      secrets: { get: async () => 'main-only-search-secret' },
      config: () => ({ enabled: true, provider: 'tavily', maxResults: 2, timeout: 10_000 })
    })
    const result = await tool.execute(
      tool.validate({ query: 'recent release notes', maxResults: 20 }),
      { signal: new AbortController().signal } as never
    )
    expect(request).toMatchObject({
      query: 'recent release notes',
      provider: 'tavily',
      maxResults: 2,
      apiKey: 'main-only-search-secret'
    })
    expect(JSON.stringify(result)).not.toContain('main-only-search-secret')
  })

  it('does not run a disabled Main search configuration', async () => {
    const tool = createWebSearchRuntimeTool({
      config: () => ({ enabled: false, provider: 'tavily', maxResults: 5, timeout: 10_000 })
    })
    await expect(
      tool.execute(tool.validate({ query: 'release notes' }), {
        signal: new AbortController().signal
      } as never)
    ).rejects.toThrow('WEB_SEARCH_DISABLED')
  })

  it('keeps legacy agent WebSearch and WebFetch names with their existing inputs', async () => {
    const fetch = createLegacyWebFetchRuntimeTool()
    expect(fetch.name).toBe('WebFetch')
    expect(fetch.validate({ url: 'https://example.test', format: 'markdown' })).toEqual({
      urls: ['https://example.test/'],
      format: 'markdown',
      timeout: 30_000
    })
    const search = createLegacyWebSearchRuntimeTool({
      config: () => ({ enabled: true, provider: 'tavily', maxResults: 5, timeout: 10_000 }),
      service: {
        search: async (request) => ({
          query: request.query,
          provider: request.provider,
          totalResults: 0,
          results: []
        })
      },
      secrets: { get: async () => '' }
    })
    expect(search.name).toBe('WebSearch')
    expect(search.validate({ query: 'recent news', searchMode: 'news' })).toEqual({
      query: 'recent news',
      maxResults: 5,
      searchMode: 'news'
    })
  })
})
