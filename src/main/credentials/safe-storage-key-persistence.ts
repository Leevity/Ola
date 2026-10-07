import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/** Chromium creates Windows safeStorage's key asynchronously in sessionData. */
export async function waitForWindowsSafeStorageKeyFile(
  localStatePath: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(localStatePath, 'utf8')) as {
        os_crypt?: { encrypted_key?: unknown }
      }
      if (typeof state.os_crypt?.encrypted_key === 'string' && state.os_crypt.encrypted_key) {
        return
      }
    } catch {
      // The file may be absent or between Chromium's atomic writes.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error('Windows credential encryption key was not persisted')
}

/** Call after encryptString and before committing its ciphertext to disk. */
export async function waitForSafeStorageKeyPersistence(): Promise<void> {
  if (process.platform !== 'win32') return
  await waitForWindowsSafeStorageKeyFile(join(app.getPath('sessionData'), 'Local State'))
}
