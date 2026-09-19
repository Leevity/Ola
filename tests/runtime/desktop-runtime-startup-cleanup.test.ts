import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/remote/account-lifecycle', () => ({
  onRemoteAccountCleared: () => {
    throw new Error('EVENT_SUBSCRIBE_FAILED')
  },
  onWorkspaceDirectoryChanged: () => () => undefined
}))

import { DesktopRuntime } from '../../src/main/runtime/desktop-runtime'
import { readDesktopRuntimeConnection } from '../../src/runtime/host/desktop-connection'

it('clears a published local token if later desktop startup fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-runtime-startup-cleanup-'))
  const descriptorPath = join(directory, 'desktop-runtime.json')
  const runtime = new DesktopRuntime(descriptorPath)
  try {
    await expect(runtime.start(directory)).rejects.toThrow('EVENT_SUBSCRIBE_FAILED')
    expect(runtime.isAvailable).toBe(false)
    await expect(readDesktopRuntimeConnection(descriptorPath)).resolves.toBeNull()
  } finally {
    await runtime.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
