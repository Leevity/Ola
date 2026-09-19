import { expect, it } from 'vitest'
import { SyncHandoverGate } from '../../src/main/sync/sync-handover-gate'

it('blocks new sync admissions while waiting for an active run to drain', async () => {
  const gate = new SyncHandoverGate()
  const release = gate.enter()
  let drained = false
  const quiescing = gate.quiesce().then(() => {
    drained = true
  })
  expect(() => gate.enter()).toThrow('SYNC_HANDOVER_QUIESCING')
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await quiescing
  expect(drained).toBe(true)
  expect(() => gate.enter()).toThrow('SYNC_HANDOVER_QUIESCING')
})

it('fails closed when an active sync does not drain before the deadline', async () => {
  const gate = new SyncHandoverGate()
  const release = gate.enter()
  await expect(gate.quiesce(1)).rejects.toThrow('SYNC_RUNS_ACTIVE_DURING_HANDOVER')
  expect(() => gate.enter()).toThrow('SYNC_HANDOVER_QUIESCING')
  release()
  await expect(gate.quiesce()).resolves.toBeUndefined()
})
