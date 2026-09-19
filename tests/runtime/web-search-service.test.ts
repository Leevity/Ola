import { describe, expect, it } from 'vitest'
import { WebSearchService } from '../../src/main/web/web-search-service'

describe('WebSearchService', () => {
  it('sends the legacy Tavily payload and normalizes results', async () => {
    let request: RequestInit | undefined
    const service = new WebSearchService(async (_url, init) => {
      request = init
      return new Response(
        JSON.stringify({
          results: [{ title: 'Result', url: 'https://example.test', content: 'text', score: 0.8 }]
        }),
        { status: 200 }
      )
    })
    const result = await service.search({
      query: 'hello',
      provider: 'tavily',
      apiKey: 'secret',
      maxResults: 3
    })
    expect(JSON.parse(String(request?.body))).toEqual({
      query: 'hello',
      api_key: 'secret',
      max_results: 3,
      search_mode: 'web'
    })
    expect(result).toMatchObject({ totalResults: 1, results: [{ title: 'Result', score: 0.8 }] })
  })

  it('requires provider keys and preserves the Exa MCP instructional result', async () => {
    const service = new WebSearchService(async () => new Response('{}', { status: 200 }))
    await expect(service.search({ query: 'hello', provider: 'exa' })).rejects.toThrow(
      'Exa API key is required'
    )
    await expect(service.search({ query: 'hello', provider: 'exa-mcp' })).resolves.toMatchObject({
      totalResults: 0,
      results: [{ title: 'Exa MCP Search' }]
    })
  })

  it('bounds large search responses and propagates an external cancellation signal', async () => {
    const large = new WebSearchService(
      async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 })
    )
    await expect(large.search({ query: 'hello', provider: 'searxng' })).rejects.toThrow(
      'Response exceeds 2 MB limit'
    )

    const cancelled = new WebSearchService(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    const controller = new AbortController()
    const request = cancelled.search({
      query: 'hello',
      provider: 'searxng',
      signal: controller.signal
    })
    controller.abort()
    await expect(request).rejects.toThrow('Request cancelled')
  })
})
