import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearDesktopRuntimeConnection,
  desktopRuntimeDescriptorPath,
  publishDesktopRuntimeConnection,
  readDesktopRuntimeConnection
} from '../../src/runtime/host/desktop-connection'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('desktop runtime connection descriptor', () => {
  it('places the default descriptor below a dedicated private directory', () => {
    expect(desktopRuntimeDescriptorPath('/isolated-ola')).toBe(
      join('/isolated-ola', 'runtime-private', 'desktop-runtime.json')
    )
  })

  it('publishes a private descriptor that can be read by the local CLI and cleared by owner token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-desktop-connection-'))
    cleanup.push(directory)
    const path = desktopRuntimeDescriptorPath(directory)
    await publishDesktopRuntimeConnection({ endpoint: '/tmp/ola.sock', token: 'token-123' }, path)
    await expect(readDesktopRuntimeConnection(path)).resolves.toEqual({
      endpoint: '/tmp/ola.sock',
      token: 'token-123'
    })
    await clearDesktopRuntimeConnection('another-token', path)
    await expect(readDesktopRuntimeConnection(path)).resolves.not.toBeNull()
    await clearDesktopRuntimeConnection('token-123', path)
    await expect(readDesktopRuntimeConnection(path)).resolves.toBeNull()
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a descriptor that becomes group-readable',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ola-desktop-connection-'))
      cleanup.push(directory)
      const path = desktopRuntimeDescriptorPath(directory)
      await publishDesktopRuntimeConnection({ endpoint: '/tmp/ola.sock', token: 'token-123' }, path)
      await chmod(path, 0o644)
      await expect(readDesktopRuntimeConnection(path)).resolves.toBeNull()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'refuses a shared descriptor directory without changing its permissions',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ola-desktop-shared-descriptor-'))
      cleanup.push(root)
      const directory = join(root, 'shared')
      await mkdir(directory, { mode: 0o755 })
      await chmod(directory, 0o755)
      await expect(
        publishDesktopRuntimeConnection(
          { endpoint: '/tmp/ola.sock', token: 'token-123' },
          join(directory, 'desktop-runtime.json')
        )
      ).rejects.toThrow('DESKTOP_RUNTIME_DESCRIPTOR_DIRECTORY_UNSAFE')
      expect((await stat(directory)).mode & 0o777).toBe(0o755)
    }
  )

  it.runIf(process.platform !== 'win32')('does not trust a linked descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-desktop-linked-descriptor-'))
    cleanup.push(directory)
    const path = desktopRuntimeDescriptorPath(directory)
    await publishDesktopRuntimeConnection({ endpoint: '/tmp/ola.sock', token: 'token-123' }, path)
    const alias = join(directory, 'alias.json')
    await symlink(path, alias)
    await expect(readDesktopRuntimeConnection(alias)).resolves.toBeNull()
  })
})
