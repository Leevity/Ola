import { resolve, relative, isAbsolute, join } from 'node:path'

const EXTENSION_ID = /^[a-z0-9_-]{2,64}$/

export function normalizeExtensionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!EXTENSION_ID.test(id)) throw new Error('Invalid extension id')
  return id
}

export function resolveExtensionPath(extensionsDirectory: string, extensionId: unknown): string {
  const root = resolve(extensionsDirectory)
  const target = resolve(root, normalizeExtensionId(extensionId))
  const pathRelative = relative(root, target)
  if (pathRelative.startsWith('..') || isAbsolute(pathRelative))
    throw new Error('Path escapes extension directory')
  return target
}

export function resolveExtensionAssetPath(
  extensionsDirectory: string,
  extensionId: unknown,
  assetPath: unknown
): string {
  if (typeof assetPath !== 'string' || !assetPath.trim())
    throw new Error('Invalid extension asset path')
  const root = resolveExtensionPath(extensionsDirectory, extensionId)
  const target = resolve(root, assetPath)
  const pathRelative = relative(root, target)
  if (pathRelative.startsWith('..') || isAbsolute(pathRelative))
    throw new Error('Asset path escapes extension')
  return target
}

export function extensionManifestPath(extensionsDirectory: string, extensionId: unknown): string {
  return join(resolveExtensionPath(extensionsDirectory, extensionId), 'extension.json')
}
