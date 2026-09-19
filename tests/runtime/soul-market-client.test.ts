import { describe, expect, it } from 'vitest'
import { SoulMarketClient } from '../../src/main/user-content/soul-market-client'

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init })
}

describe('SoulMarketClient', () => {
  it('uses a bounded, encoded marketplace search request', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new SoulMarketClient({
      userAgent: 'Ola/test',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response(JSON.stringify({ total: 4, data: [{ slug: 'writer' }] }))
      }
    })

    await expect(
      client.list({
        query: 'a & b',
        category: 'writing',
        offset: 201,
        limit: 999,
        sortBy: 'name',
        apiKey: 'key'
      })
    ).resolves.toEqual(expect.objectContaining({ total: 4 }))

    expect(requests[0]?.url).toBe(
      'https://skills.ola.shop/api/v1/souls/search?page=3&limit=100&sortBy=name&q=a+%26+b&category=writing'
    )
    expect(requests[0]?.init?.redirect).toBe('error')
    expect(requests[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer key',
      'User-Agent': 'Ola/test'
    })
  })

  it('never follows an arbitrary download URL and returns fallback categories on failure', async () => {
    const client = new SoulMarketClient({
      userAgent: 'Ola/test',
      fetch: async () => {
        throw new Error('offline')
      }
    })

    await expect(
      client.download({ slug: 'writer', downloadUrl: 'https://example.com/soul.md' })
    ).rejects.toThrow('allowed marketplace')
    await expect(client.categories()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'coding' })])
    )
  })

  it('rejects failed or oversized marketplace downloads', async () => {
    const failed = new SoulMarketClient({
      userAgent: 'Ola/test',
      fetch: async () =>
        response(JSON.stringify({ error: { code: 'gone', message: 'No longer available' } }), {
          status: 410
        })
    })
    await expect(failed.download({ slug: 'writer' })).rejects.toThrow('gone: No longer available')

    const oversized = new SoulMarketClient({
      userAgent: 'Ola/test',
      fetch: async () =>
        response('content', { headers: { 'content-length': String(3 * 1024 * 1024) } })
    })
    await expect(oversized.download({ slug: 'writer' })).rejects.toThrow('maximum allowed size')
  })
})
