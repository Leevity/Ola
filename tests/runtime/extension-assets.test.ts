import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_EXTENSION_ASSET_BYTES,
  readExtensionAsset
} from '../../src/main/extensions/extension-assets'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('extension workbench assets', () => {
  it('reads assets contained by the real extension directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-extension-asset-'))
    const extensionRoot = join(root, 'extensions', 'weather')
    await mkdir(join(extensionRoot, 'views'), { recursive: true })
    await writeFile(join(extensionRoot, 'views', 'dashboard.html'), '<h1>Dashboard</h1>')

    await expect(readExtensionAsset(extensionRoot, 'views/dashboard.html')).resolves.toBe(
      '<h1>Dashboard</h1>'
    )
  })

  it('rejects symlinked asset directories that resolve outside the extension', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-extension-asset-'))
    const extensionRoot = join(root, 'extensions', 'weather')
    const outsideDirectory = join(root, 'outside')
    await mkdir(extensionRoot, { recursive: true })
    await mkdir(outsideDirectory)
    await writeFile(join(outsideDirectory, 'dashboard.html'), 'outside content')
    await symlink(outsideDirectory, join(extensionRoot, 'views'), 'junction')

    await expect(readExtensionAsset(extensionRoot, 'views/dashboard.html')).rejects.toThrow(
      'Extension asset escapes extension directory'
    )
  })

  it('rejects traversal and assets larger than 8 MiB', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-extension-asset-'))
    const extensionRoot = join(root, 'extensions', 'weather')
    await mkdir(join(extensionRoot, 'views'), { recursive: true })
    await writeFile(join(extensionRoot, 'large.html'), Buffer.alloc(MAX_EXTENSION_ASSET_BYTES + 1))

    await expect(readExtensionAsset(extensionRoot, '../outside.html')).rejects.toThrow()
    await expect(readExtensionAsset(extensionRoot, 'large.html')).rejects.toThrow(
      'Extension asset must be a file no larger than 8 MiB'
    )
  })
})
