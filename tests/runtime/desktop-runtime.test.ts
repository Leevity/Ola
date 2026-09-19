import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopRuntime } from '../../src/main/runtime/desktop-runtime'
import { RUNTIME_PROTOCOL_VERSION } from '../../src/shared/runtime/contracts'
import {
  publishDesktopRuntimeConnection,
  readDesktopRuntimeConnection
} from '../../src/runtime/host/desktop-connection'

it('starts one Main-owned runtime, serves an authenticated client, and removes its descriptor', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ola-desktop-runtime-'))
  const runtime = new DesktopRuntime(join(dataDirectory, 'desktop-runtime.json'))
  try {
    await Promise.all([runtime.start(dataDirectory), runtime.start(dataDirectory)])
    expect(runtime.isAvailable).toBe(true)
    const descriptor = JSON.parse(
      await readFile(join(dataDirectory, 'runtime-v2', 'connection.json'), 'utf8')
    ) as { endpoint: string; token: string; version: number }
    expect(descriptor.version).toBe(RUNTIME_PROTOCOL_VERSION)

    await expect(runtime.request('ping')).resolves.toEqual({ version: RUNTIME_PROTOCOL_VERSION })

    await runtime.stop()
    expect(runtime.isAvailable).toBe(false)
    await expect(runtime.request('ping')).rejects.toMatchObject({ code: 'RUNTIME_DISCONNECTED' })
    await expect(
      readFile(join(dataDirectory, 'runtime-v2', 'connection.json'), 'utf8')
    ).rejects.toThrow()
  } finally {
    await runtime.stop()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

it('does not leave a service running when shutdown races startup', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ola-desktop-runtime-stop-'))
  const runtime = new DesktopRuntime(join(dataDirectory, 'desktop-runtime.json'))
  try {
    const starting = runtime.start(dataDirectory)
    await runtime.stop()
    await starting
    expect(runtime.isAvailable).toBe(false)
    await expect(
      readFile(join(dataDirectory, 'runtime-v2', 'connection.json'), 'utf8')
    ).rejects.toThrow()
  } finally {
    await runtime.stop()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

it('removes the local connection token even if service shutdown fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-desktop-runtime-stop-failure-'))
  const descriptorPath = join(directory, 'desktop-runtime.json')
  const runtime = new DesktopRuntime(descriptorPath)
  try {
    await publishDesktopRuntimeConnection(
      { endpoint: 'test-endpoint', token: 'test-token' },
      descriptorPath
    )
    const mutableRuntime = runtime as unknown as { service: unknown }
    mutableRuntime.service = {
      token: 'test-token',
      stop: async () => {
        throw new Error('STOP_FAILED')
      }
    }
    await expect(runtime.stop()).rejects.toThrow('STOP_FAILED')
    await expect(readDesktopRuntimeConnection(descriptorPath)).resolves.toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
