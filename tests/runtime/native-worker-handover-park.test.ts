import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { NativeWorkerManager } from '../../src/main/lib/native-worker'

describe('Native Worker handover parking', () => {
  it('waits for an already admitted request before parking the Worker', async () => {
    const manager = new NativeWorkerManager()
    let finish!: () => void
    const requestCore = manager as unknown as {
      requestCore: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>
    }
    vi.spyOn(requestCore, 'requestCore').mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          finish = () => resolve('committed')
        })
    )
    const request = manager.request('db/sessions-create')
    await expect.poll(() => typeof finish).toBe('function')
    let parked = false
    const handover = manager.parkForHandover(1_000).then(() => {
      parked = true
    })
    await expect(manager.request('db/sessions-create')).rejects.toThrow(
      'NATIVE_WORKER_HANDOVER_QUIESCED'
    )
    expect(parked).toBe(false)
    finish()
    await expect(request).resolves.toBe('committed')
    await handover
    expect(parked).toBe(true)
  })
  it('waits for its child process to exit and forbids implicit restart', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    try {
      await once(child, 'spawn')
      const manager = new NativeWorkerManager()
      ;(manager as unknown as { child: typeof child }).child = child
      await manager.parkForHandover(1000)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      await expect(manager.ensureStarted()).rejects.toThrow(
        'Native worker is parked for database handover'
      )
      await expect(manager.request('worker/ping')).rejects.toThrow(
        'Native worker is parked for database handover'
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})
