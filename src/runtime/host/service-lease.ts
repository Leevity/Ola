import { mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { RuntimeError } from '../../shared/runtime/contracts'

/** SQLite holds the OS write lock in a dedicated worker; process death releases it automatically. */
export async function acquireServiceLease(
  directory: string
): Promise<{ release: () => Promise<void>; signal: AbortSignal }> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const worker = new Worker(new URL('../storage/lease-worker.mjs', import.meta.url), {
    workerData: { path: join(directory, 'lease.db') }
  })
  const lost = new AbortController()
  let releasing = false
  worker.on('error', () => {
    if (!releasing) lost.abort()
  })
  worker.on('exit', () => {
    if (!releasing) lost.abort()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.once('exit', () => reject(new RuntimeError('RUNTIME_LEASE_LOST')))
      worker.once('message', (message: { ready?: boolean; error?: string }) =>
        message.ready ? resolve() : reject(new RuntimeError(message.error ?? 'RUNTIME_DATA_LOCKED'))
      )
    })
  } catch (error) {
    await worker.terminate()
    throw error
  }
  return {
    signal: lost.signal,
    release: async () => {
      if (releasing) return
      releasing = true
      await worker.terminate()
    }
  }
}
