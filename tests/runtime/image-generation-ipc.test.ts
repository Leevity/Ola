import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { encode } from '@msgpack/msgpack'

const handlers = new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => handlers.set(channel, handler)
  }
}))

import { registerImageGenerationHandlers } from '../../src/main/ipc/image-generation-handlers'

beforeEach(() => {
  handlers.clear()
  registerImageGenerationHandlers()
})

it('keeps image generation on the Main TS provider route and rejects invalid input', async () => {
  const handler = handlers.get('image:generate:msgpack')
  expect(handler).toBeDefined()
  await expect(handler!({}, encode({ prompt: 'missing provider' }))).rejects.toThrow(
    'IMAGE_RUNTIME_INVALID_REQUEST'
  )
})
