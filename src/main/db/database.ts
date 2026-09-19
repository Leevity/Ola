import { getNativeWorker } from '../lib/native-worker'
import { olaDataRoot } from '../lib/ola-data-root'
import { closeLegacyReadCanary } from './legacy-read-canary'
import { closeBusinessWriteCanary } from './business-write-canary'

interface DbInitializeResult {
  success: boolean
  dbPath: string
  error?: string | null
}

let initializePromise: Promise<void> | null = null

export async function initializeDatabase(): Promise<void> {
  initializePromise ??= getNativeWorker()
    .request<DbInitializeResult>('db/initialize', {}, 120_000)
    .then((result) => {
      if (!result.success) {
        throw new Error(result.error || 'Native DB initialization failed')
      }
      console.log('[DB][Native] initialized', { dbPath: result.dbPath })
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
