import { beforeEach, describe, expect, it, vi } from 'vitest'

const { businessWriteCanary, closeLegacyReadCanary, closeBusinessWriteCanary } = vi.hoisted(() => ({
  businessWriteCanary: vi.fn(),
  closeLegacyReadCanary: vi.fn(),
  closeBusinessWriteCanary: vi.fn()
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary,
  closeBusinessWriteCanary
}))
vi.mock('../../src/main/db/legacy-read-canary', () => ({ closeLegacyReadCanary }))

describe('TS database initialization', () => {
  beforeEach(() => {
    vi.resetModules()
    businessWriteCanary.mockReset()
    closeLegacyReadCanary.mockReset()
    closeBusinessWriteCanary.mockReset()
  })

  it('initializes through the TS BusinessRepository canary', async () => {
    businessWriteCanary.mockReturnValue({ kind: 'ts-business-repository' })
    const { initializeDatabase, closeDb } = await import('../../src/main/db/database')

    await expect(initializeDatabase()).resolves.toBeUndefined()
    expect(businessWriteCanary).toHaveBeenCalledTimes(1)
    closeDb()
    expect(closeBusinessWriteCanary).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the TS repository is unavailable', async () => {
    businessWriteCanary.mockReturnValue(null)
    const { initializeDatabase } = await import('../../src/main/db/database')

    await expect(initializeDatabase()).rejects.toThrow('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  })
})
