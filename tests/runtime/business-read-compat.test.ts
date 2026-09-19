import { describe, expect, it } from 'vitest'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

describe('promoted business read compatibility', () => {
  it('keeps every LegacyReadRepository method available on BusinessRepository', () => {
    const legacyMethods = Object.getOwnPropertyNames(LegacyReadRepository.prototype).filter(
      (name) => name !== 'constructor' && name !== 'close'
    )
    const businessPrototype = BusinessRepository.prototype as unknown as Record<string, unknown>
    expect(legacyMethods.length).toBeGreaterThanOrEqual(55)
    expect(legacyMethods.filter((name) => typeof businessPrototype[name] !== 'function')).toEqual(
      []
    )
  })
})
