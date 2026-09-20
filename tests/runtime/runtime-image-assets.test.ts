import { readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readRuntimeImageAsset,
  readRuntimeImageAssetBytes,
  stageRuntimeImageAsset
} from '../../src/runtime/storage/runtime-image-assets'

describe('runtime image assets', () => {
  let root = ''

  afterEach(async () => {
    vi.unstubAllEnvs()
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('stages a large image outside the runtime frame and reads it by workspace-bound asset id', async () => {
    root = join(tmpdir(), `ola-runtime-image-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    vi.stubEnv('OLA_E2E_DATA_ROOT', root)
    const payload = Buffer.alloc(1024 * 1024 + 17, 0xab)
    const staged = await stageRuntimeImageAsset({
      workspaceId: 'workspace-a',
      mimeType: 'image/png',
      base64: payload.toString('base64')
    })

    expect(staged.bytes).toBe(payload.byteLength)
    expect(
      readRuntimeImageAsset({ workspaceId: 'workspace-a', ...staged, mimeType: 'image/png' })
    ).toBe(`data:image/png;base64,${payload.toString('base64')}`)
    expect(
      Buffer.from(
        await readRuntimeImageAssetBytes({ workspaceId: 'workspace-a', assetId: staged.assetId })
      )
    ).toEqual(payload)
    await expect(
      readFile(join(root, 'runtime-assets', 'workspace-b', `${staged.assetId}.bin`))
    ).rejects.toThrow()
    const files = await readdir(join(root, 'runtime-assets'))
    expect(files).toHaveLength(1)
  })

  it('rejects unsupported image formats and oversized decoded payloads', async () => {
    root = join(tmpdir(), `ola-runtime-image-invalid-${Date.now()}`)
    vi.stubEnv('OLA_E2E_DATA_ROOT', root)
    await expect(
      stageRuntimeImageAsset({
        workspaceId: 'workspace-a',
        mimeType: 'image/svg+xml',
        base64: 'aA=='
      })
    ).rejects.toThrow('INVALID_RUNTIME_ASSET')
    await expect(
      stageRuntimeImageAsset({
        workspaceId: 'workspace-a',
        mimeType: 'image/jpeg',
        base64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')
      })
    ).rejects.toThrow('RUNTIME_ASSET_TOO_LARGE')
  })
})
