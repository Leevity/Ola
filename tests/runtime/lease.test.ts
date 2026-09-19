import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireServiceLease } from '../../src/runtime/host/service-lease'
it('allows exactly one data owner and can acquire again after its worker exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ola-lease-'))
  const lease = await acquireServiceLease(dir)
  try {
    await expect(acquireServiceLease(dir)).rejects.toThrow('RUNTIME_DATA_LOCKED')
    await lease.release()
    const next = await acquireServiceLease(dir)
    await next.release()
  } finally {
    await lease.release()
    await rm(dir, { recursive: true, force: true })
  }
})
