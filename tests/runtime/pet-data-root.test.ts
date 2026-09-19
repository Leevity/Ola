import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({ ipcClient: { invoke } }))

import { getPetsDir } from '../../src/renderer/src/stores/pet-skin-store'

it('uses the Main-owned pet data directory rather than reconstructing it from home', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'pet:data-dir' ? '/isolated-ola/pets' : null
  )
  await expect(getPetsDir()).resolves.toBe('/isolated-ola/pets')
  expect(invoke).toHaveBeenCalledWith('pet:data-dir')
  expect(invoke).not.toHaveBeenCalledWith('app:homedir')

  const handlers = await readFile('src/main/ipc/pet-handlers.ts', 'utf8')
  expect(handlers).toContain(
    "registerMessagePackHandler<void>('pet:data-dir', () => getPetsDirMain())"
  )
})
