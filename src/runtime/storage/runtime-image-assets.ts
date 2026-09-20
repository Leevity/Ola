import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

const MAX_ASSET_BYTES = 20 * 1024 * 1024
const ASSET_ID_PATTERN = /^[a-f0-9-]{36}$/

function dataRoot(): string {
  return process.env.OLA_E2E_DATA_ROOT || join(homedir(), '.ola')
}

function workspaceKey(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex')
}

function assetDirectory(workspaceId: string): string {
  return join(dataRoot(), 'runtime-assets', workspaceKey(workspaceId))
}

export function runtimeImageAssetPath(workspaceId: string, assetId: string): string {
  if (!ASSET_ID_PATTERN.test(assetId)) throw new Error('INVALID_RUNTIME_ASSET')
  return join(assetDirectory(workspaceId), `${assetId}.bin`)
}

export async function stageRuntimeImageAsset(input: {
  workspaceId: string
  mimeType: string
  base64: string
}): Promise<{ assetId: string; bytes: number }> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(input.mimeType)) throw new Error('INVALID_RUNTIME_ASSET')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw new Error('INVALID_RUNTIME_ASSET')
  const payload = Buffer.from(input.base64, 'base64')
  if (!payload.length || payload.byteLength > MAX_ASSET_BYTES)
    throw new Error('RUNTIME_ASSET_TOO_LARGE')
  const directory = assetDirectory(input.workspaceId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const assetId = randomUUID()
  const target = runtimeImageAssetPath(input.workspaceId, assetId)
  const staging = `${target}.staging-${randomUUID()}`
  await writeFile(staging, payload, { mode: 0o600, flag: 'wx' })
  try {
    await writeFile(`${target}.meta`, JSON.stringify({ mimeType: input.mimeType }), {
      mode: 0o600,
      flag: 'wx'
    })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true })
    await rm(`${target}.meta`, { force: true })
    throw error
  }
  return { assetId, bytes: payload.byteLength }
}

export function readRuntimeImageAsset(input: {
  workspaceId: string
  assetId: string
  mimeType: string
}): string {
  const path = runtimeImageAssetPath(input.workspaceId, input.assetId)
  const payload = readFileSync(path)
  if (!payload.length || payload.byteLength > MAX_ASSET_BYTES)
    throw new Error('RUNTIME_ASSET_TOO_LARGE')
  return `data:${input.mimeType};base64,${payload.toString('base64')}`
}

export async function cleanupRuntimeImageAssets(
  workspaceId: string,
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<number> {
  const directory = assetDirectory(workspaceId)
  const entries = await readdir(directory).catch(() => [])
  let removed = 0
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.endsWith('.bin')) continue
    const path = join(directory, entry)
    const info = await stat(path).catch(() => null)
    if (info && info.mtimeMs < cutoff) {
      await rm(path, { force: true })
      await rm(`${path.slice(0, -4)}.meta`, { force: true })
      removed++
    }
  }
  return removed
}

export async function readRuntimeImageAssetBytes(input: {
  workspaceId: string
  assetId: string
}): Promise<Uint8Array> {
  const payload = await readFile(runtimeImageAssetPath(input.workspaceId, input.assetId))
  if (!payload.length || payload.byteLength > MAX_ASSET_BYTES)
    throw new Error('RUNTIME_ASSET_TOO_LARGE')
  return payload
}
