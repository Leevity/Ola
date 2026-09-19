import { describe, expect, it } from 'vitest'
import { canPersistSecrets } from '../../src/main/credentials/secure-storage-policy'
describe('shared account and mesh secret persistence policy', () => {
  it('rejects basic_text even when Electron reports encryption availability', () => {
    expect(
      canPersistSecrets({
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text'
      })
    ).toBe(false)
  })
  it('requires a usable backend and fails closed on backend exceptions', () => {
    expect(canPersistSecrets({ isEncryptionAvailable: () => false })).toBe(false)
    expect(
      canPersistSecrets({
        isEncryptionAvailable: () => {
          throw new Error('locked')
        }
      })
    ).toBe(false)
    expect(canPersistSecrets({ isEncryptionAvailable: () => true })).toBe(true)
  })
})
