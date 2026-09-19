import { describe, expect, it } from 'vitest'
import { WebFetchService } from '../../src/main/web/web-fetch-service'

describe('WebFetchService', () => {
  it('deduplicates URLs and converts safe page content to markdown', async () => {
    const service = new WebFetchService(
      async () =>
        new Response(
          '<html><head><title>Example</title></head><body><nav>skip</nav><article><h1>Heading</h1><p>Hello <strong>world</strong> <a href="/docs">docs</a>.</p><script>skip</script></article></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        )
    )
    const result = await service.fetch({
      urls: ['https://example.test/page', 'https://example.test/page']
    })
    expect(result.totalResults).toBe(1)
    expect(result.results[0]).toMatchObject({ title: 'Example', format: 'markdown' })
    expect(result.results[0].content).toContain('# Heading')
    expect(result.results[0].content).toContain('**world**')
    expect(result.results[0].content).toContain('[docs](https://example.test/docs)')
    expect(result.results[0].content).not.toContain('skip')
  })

  it('keeps per-url failures as results', async () => {
    const service = new WebFetchService(async () => new Response('missing', { status: 404 }))
    await expect(
      service.fetch({ url: 'https://example.test/missing', format: 'text' })
    ).resolves.toEqual({
      format: 'text',
      totalResults: 0,
      results: [
        {
          url: 'https://example.test/missing',
          content: '',
          format: 'text',
          error: 'HTTP 404'
        }
      ]
    })
  })

  it('limits redirects to five hops', async () => {
    let requests = 0
    const service = new WebFetchService(async () => {
      requests += 1
      return new Response('', {
        status: 302,
        headers: { location: `https://example.test/${requests}` }
      })
    })
    const result = await service.fetch({ url: 'https://example.test/start' })
    expect(requests).toBe(6)
    expect(result.results[0].error).toBe('Too many redirects')
  })

  it('bounds response bodies before they can enter a runtime event', async () => {
    const service = new WebFetchService(
      async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 })
    )
    await expect(service.fetch({ url: 'https://example.test/large' })).resolves.toMatchObject({
      totalResults: 0,
      results: [{ error: 'Response exceeds 2 MB limit' }]
    })
  })
})
