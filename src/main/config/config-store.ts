import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'

export type ConfigMutationResult = { success: true } | { success: false; error: string }

/**
 * Owns the legacy ~/.ola/config.json root while the TS runtime replaces the
 * Worker. Mutations are serialized so independent main-process services do
 * not lose each other's top-level keys.
 */
export class ConfigStore {
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = join(olaDataRoot(), 'config.json')) {}

  async read(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  async get(key?: string): Promise<unknown> {
    const root = await this.read()
    return key?.trim() ? (root[key] ?? null) : root
  }

  async write(root: Record<string, unknown>): Promise<ConfigMutationResult> {
    if (!isRecord(root)) return { success: false, error: 'Invalid config root' }
    return await this.enqueue(async () => {
      await writeRoot(this.filePath, root)
      return { success: true }
    })
  }

  async set(key: string, value: unknown): Promise<ConfigMutationResult> {
    if (!key?.trim()) return { success: false, error: 'Missing config key' }
    return await this.mutate((root) => {
      if (value === undefined || value === null) delete root[key]
      else root[key] = value
      return { success: true }
    })
  }

  async delete(key: string): Promise<ConfigMutationResult> {
    if (!key?.trim()) return { success: false, error: 'Missing config key' }
    return await this.mutate((root) => {
      delete root[key]
      return { success: true }
    })
  }

  private async mutate(
    change: (root: Record<string, unknown>) => ConfigMutationResult
  ): Promise<ConfigMutationResult> {
    return await this.enqueue(async () => {
      const root = await this.read()
      const result = change(root)
      if (result.success) await writeRoot(this.filePath, root)
      return result
    })
  }

  private async enqueue(
    change: () => Promise<ConfigMutationResult>
  ): Promise<ConfigMutationResult> {
    let result: ConfigMutationResult = { success: false, error: 'Config write failed' }
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        result = await change()
      })
      .catch((error) => {
        result = { success: false, error: error instanceof Error ? error.message : String(error) }
      })
    await this.pendingWrite
    return result
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function writeRoot(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `config.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(root, null, 2), 'utf8')
  await rename(temporary, path)
}
