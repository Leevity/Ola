import { olaDataRoot } from '../lib/ola-data-root'
import { closeLegacyReadCanary } from './legacy-read-canary'
import { businessWriteCanary, closeBusinessWriteCanary } from './business-write-canary'

let initializePromise: Promise<void> | null = null

export async function initializeDatabase(): Promise<void> {
  initializePromise ??= Promise.resolve()
    .then(() => businessWriteCanary())
    .then((repository) => {
      if (!repository) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
      console.log('[DB][TS] initialized', { dbPath: getDataDir() + '/data.db' })
    })
    .catch((error) => {
      initializePromise = null
      throw error
    })

  await initializePromise
}

export function closeDb(): void {
  initializePromise = null
  void closeLegacyReadCanary()
  void closeBusinessWriteCanary()
}

export function getDataDir(): string {
  return olaDataRoot()
}
