import { describe, expect, it } from 'vitest'
import { SkillMarketClient } from '../../src/main/user-content/skill-market-client'

describe('SkillMarketClient', () => {
  it('normalizes marketplace results and constrains pagination', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new SkillMarketClient('Ola/test', async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ total: 1, data: [{ slug: 'writer', tags: ['text'] }] }))
    })
    await expect(
      client.list({ offset: 105, limit: 1000, query: 'a & b', apiKey: 'key' })
    ).resolves.toEqual({
      total: 1,
      skills: [
        expect.objectContaining({
          slug: 'writer',
          tags: ['text'],
          installCommand: 'npx skills add writer'
        })
      ]
    })
    expect(calls[0]?.url).toBe(
      'https://skills.ola.shop/api/v1/skills/search?page=2&limit=100&sortBy=popular&q=a+%26+b'
    )
    expect(calls[0]?.init).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer key' }
    })
  })

  it('does not issue unsupported provider requests and fails closed on bad responses', async () => {
    const client = new SkillMarketClient(
      'Ola/test',
      async () => new Response('bad', { status: 500 })
    )
    await expect(client.list({ provider: 'other' as never })).resolves.toEqual({
      total: 0,
      skills: []
    })
    await expect(client.list({})).resolves.toEqual({ total: 0, skills: [] })
  })
})
