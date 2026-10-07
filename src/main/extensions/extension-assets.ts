import { realpath, stat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const MAX_EXTENSION_ASSET_BYTES = 8 * 1024 * 1024

function assertContained(root: string, target: string): void {
  const pathRelative = relative(root, target)
  if (
    !pathRelative ||
    pathRelative === '..' ||
    pathRelative.startsWith(`..${sep}`) ||
    isAbsolute(pathRelative)
  ) {
    throw new Error('Extension asset escapes extension directory')
  }
}

/** Reads a bounded asset only after resolving symlinks and checking the real extension boundary. */
export async function readExtensionAsset(
  extensionRootPath: string,
  assetPath: unknown
): Promise<string> {
  if (typeof assetPath !== 'string' || !assetPath.trim())
    throw new Error('Invalid extension asset path')
  const extensionPath = resolve(extensionRootPath)
  const candidatePath = resolve(extensionPath, assetPath)
  assertContained(extensionPath, candidatePath)
  const [extensionRoot, resolvedAsset] = await Promise.all([
    realpath(extensionPath),
    realpath(candidatePath)
  ])
  assertContained(extensionRoot, resolvedAsset)

  const assetInfo = await stat(resolvedAsset)
  if (!assetInfo.isFile() || assetInfo.size > MAX_EXTENSION_ASSET_BYTES) {
    throw new Error('Extension asset must be a file no larger than 8 MiB')
  }
  return await readFile(resolvedAsset, 'utf8')
}
