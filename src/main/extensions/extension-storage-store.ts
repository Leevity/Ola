import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeExtensionId } from './extension-paths'

type StorageRoot = Record<string, Record<string, unknown>>

function storageKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new Error('Invalid extension storage key')
  return value.trim()
}

function parseRoot(value: string): StorageRoot {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([id, items]) =>
        items && typeof items === 'object' && !Array.isArray(items) ? [[id, { ...items }]] : []
      )
    )
  } catch {
    return {}
  }
}

/** Owns the legacy JSON KV file until the extension domain moves into SQLite. */
export class ExtensionStorageStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}

  private async read(): Promise<StorageRoot> {
    try {
      return parseRoot(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
      throw error
    }
  }

  private async write(root: StorageRoot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = join(dirname(this.path), `.${randomUUID()}.extensions-storage.json`)
    await writeFile(temporary, JSON.stringify(root, null, 2), 'utf8')
    await rename(temporary, this.path)
  }

  async get(extensionId: unknown, key: unknown): Promise<unknown | null> {
    const id = normalizeExtensionId(extensionId)
    const normalizedKey = storageKey(key)
    const root = await this.read()
    return root[id] && Object.hasOwn(root[id], normalizedKey) ? root[id][normalizedKey] : null
  }

  set(extensionId: unknown, key: unknown, value: unknown): Promise<void> {
    return this.mutate(async (root) => {
      const id = normalizeExtensionId(extensionId)
      const normalizedKey = storageKey(key)
      root[id] ??= {}
      root[id][normalizedKey] = value
    })
  }

  delete(extensionId: unknown, key: unknown): Promise<void> {
    return this.mutate(async (root) => {
      const id = normalizeExtensionId(extensionId)
      delete root[id]?.[storageKey(key)]
    })
  }

  deleteExtension(extensionId: unknown): Promise<void> {
    const id = normalizeExtensionId(extensionId)
    return this.mutate(async (root) => {
      delete root[id]
    })
  }

  private mutate(change: (root: StorageRoot) => Promise<void>): Promise<void> {
    const result = this.tail.then(async () => {
      const root = await this.read()
      await change(root)
      await this.write(root)
    })
    this.tail = result.catch(() => undefined)
    return result
  }
}
