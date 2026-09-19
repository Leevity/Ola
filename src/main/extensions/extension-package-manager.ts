import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readExtensionManifest, readExtensionManifestFromDirectory } from './extension-manifest'
import { normalizeExtensionId, resolveExtensionPath } from './extension-paths'
import type { ExtensionSecretStore } from './extension-service'
import { ExtensionStateStore } from './extension-state-store'
import { ExtensionStorageStore } from './extension-storage-store'

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch {
    return false
  }
}

async function directoryFingerprint(directory: string): Promise<string> {
  const files: string[] = []
  const visit = async (current: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) await visit(join(current, entry.name), relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  await visit(directory)
  const hash = createHash('sha256')
  for (const relative of files.sort()) {
    hash.update(relative)
    hash.update(Buffer.from([0]))
    hash.update(await readFile(join(directory, ...relative.split('/'))))
    hash.update(Buffer.from([0xff]))
  }
  return hash.digest('hex')
}

async function copyDirectoryAtomically(
  source: string,
  target: string,
  replace: boolean
): Promise<void> {
  const staging = target + '.ola-staging-' + randomUUID()
  const backup = target + '.ola-backup-' + randomUUID()
  let movedExisting = false
  let installed = false
  try {
    await mkdir(dirname(target), { recursive: true })
    await cp(source, staging, { recursive: true, force: true, errorOnExist: true })
    if (replace && (await exists(target))) {
      await rename(target, backup)
      movedExisting = true
    }
    await rename(staging, target)
    installed = true
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (installed) await rm(target, { recursive: true, force: true })
    if (movedExisting && (await exists(backup)) && !(await exists(target)))
      await rename(backup, target)
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (installed) await rm(backup, { recursive: true, force: true })
  }
}

/** Owns install/remove and bundled-package replacement once the TS route is enabled. */
export class ExtensionPackageManager {
  constructor(
    private readonly extensionsDirectory: string,
    private readonly stateStore: ExtensionStateStore,
    private readonly storageStore: ExtensionStorageStore,
    private readonly secrets: ExtensionSecretStore
  ) {}

  async installFromFolder(sourcePath: string): Promise<string> {
    const source = sourcePath.trim()
    if (!source || !(await exists(source)))
      throw new Error('Extension source folder not found: ' + source)
    const manifest = await readExtensionManifestFromDirectory(source)
    const target = resolveExtensionPath(this.extensionsDirectory, manifest.id)
    if (await exists(target)) throw new Error('Extension "' + manifest.id + '" already exists')
    await copyDirectoryAtomically(source, target, false)
    try {
      await this.stateStore.getOrCreate(manifest.id)
      return manifest.id
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
  }

  async remove(extensionId: unknown): Promise<void> {
    const id = normalizeExtensionId(extensionId)
    const manifest = await readExtensionManifest(this.extensionsDirectory, id)
    await rm(resolveExtensionPath(this.extensionsDirectory, id), { recursive: true, force: true })
    await Promise.all([
      this.stateStore.delete(id),
      this.storageStore.deleteExtension(id),
      ...(manifest.configSchema ?? [])
        .filter((field) => field.type === 'secret')
        .map((field) => this.secrets.delete(id, field.key))
    ])
  }

  async ensureBundled(candidates: readonly string[]): Promise<void> {
    let bundledDirectory: string | undefined
    for (const candidate of candidates) {
      if (candidate.trim() && (await exists(candidate))) {
        bundledDirectory = candidate
        break
      }
    }
    if (!bundledDirectory) return
    for (const entry of await readdir(bundledDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = join(bundledDirectory, entry.name)
      try {
        const sourceManifest = await readExtensionManifestFromDirectory(source)
        if (sourceManifest.id !== basename(source)) continue
        const target = resolveExtensionPath(this.extensionsDirectory, sourceManifest.id)
        const current = await this.stateStore.get(sourceManifest.id)
        const shouldUpdate =
          !(await exists(target)) ||
          (await this.shouldUpdate(source, target, sourceManifest.version))
        if (shouldUpdate) await copyDirectoryAtomically(source, target, true)
        if (!current) await this.stateStore.getOrCreate(sourceManifest.id, true)
      } catch {
        // A broken bundled package is skipped so it cannot block other extensions.
      }
    }
  }

  private async shouldUpdate(source: string, target: string, version: string): Promise<boolean> {
    try {
      const installed = await readExtensionManifestFromDirectory(target)
      return (
        installed.version !== version ||
        (await directoryFingerprint(source)) !== (await directoryFingerprint(target))
      )
    } catch {
      return true
    }
  }
}
