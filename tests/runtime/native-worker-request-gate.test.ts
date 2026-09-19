import { expect, it } from 'vitest'
import { NativeWorkerRequestGate } from '../../src/main/lib/native-worker-request-gate'

it('drains already admitted requests and rejects new ones before handover', async () => {
  const gate = new NativeWorkerRequestGate()
  let finish!: () => void
  const pending = gate.run(
    async () =>
      await new Promise<string>((resolve) => {
        finish = () => resolve('completed')
      })
  )
  await expect.poll(() => typeof finish).toBe('function')
  let drained = false
  const quiesce = gate.quiesce(1_000).then(() => {
    drained = true
  })
  await expect(gate.run(async () => 'late')).rejects.toThrow('NATIVE_WORKER_HANDOVER_QUIESCED')
  expect(drained).toBe(false)
  finish()
  await expect(pending).resolves.toBe('completed')
  await quiesce
  expect(drained).toBe(true)
})

it('fails closed when an admitted request fails or does not drain in time', async () => {
  const failed = new NativeWorkerRequestGate()
  let fail!: () => void
  const pendingFailure = failed.run(
    async () =>
      await new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error('worker lost'))
      })
  )
  await expect.poll(() => typeof fail).toBe('function')
  const rejectedDrain = expect(failed.quiesce(1_000)).rejects.toThrow(
    'NATIVE_WORKER_REQUEST_FAILED_DURING_HANDOVER'
  )
  fail()
  await expect(pendingFailure).rejects.toThrow('worker lost')
  await rejectedDrain
  await expect(failed.run(async () => undefined)).rejects.toThrow('NATIVE_WORKER_HANDOVER_QUIESCED')

  const timedOut = new NativeWorkerRequestGate()
  let finish!: () => void
  const pending = timedOut.run(
    async () =>
      await new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  await expect.poll(() => typeof finish).toBe('function')
  await expect(timedOut.quiesce(100)).rejects.toThrow('NATIVE_WORKER_REQUEST_DRAIN_TIMEOUT')
  await expect(timedOut.run(async () => undefined)).rejects.toThrow(
    'NATIVE_WORKER_HANDOVER_QUIESCED'
  )
  finish()
  await pending
})
