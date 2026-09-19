import { describe, expect, it } from 'vitest'
import {
  normalizeSoulCategories,
  normalizeSoulMarketResponse,
  validateSoulDownloadUrl
} from '../../src/main/user-content/soul-market-contract'

describe('Soul market contract', () => {
  it('normalizes market records and rejects untrusted download URLs', () => {
    expect(
      normalizeSoulMarketResponse({ data: [{ id: '1', slug: 'writer', downloads: 2 }] })
    ).toEqual({
      total: 1,
      souls: [expect.objectContaining({ id: '1', slug: 'writer', downloads: 2 })]
    })
    expect(() => validateSoulDownloadUrl('https://example.com/file')).toThrow('allowed marketplace')
    expect(() =>
      validateSoulDownloadUrl('http://skills.ola.shop/api/v1/souls/a/download')
    ).toThrow()
    expect(
      validateSoulDownloadUrl('https://skills.ola.shop/api/v1/souls/a/download').pathname
    ).toContain('/souls/a/download')
  })

  it('uses fallback categories for API failures', () => {
    expect(normalizeSoulCategories({ success: false })).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'coding' })])
    )
  })
})
