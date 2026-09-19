export interface SecureStorageBackend {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
}

/** Electron's basic_text backend is obfuscation, not an acceptable persistent secret store. */
export function canPersistSecrets(backend: SecureStorageBackend): boolean {
  try {
    return backend.isEncryptionAvailable() && backend.getSelectedStorageBackend?.() !== 'basic_text'
  } catch {
    return false
  }
}
