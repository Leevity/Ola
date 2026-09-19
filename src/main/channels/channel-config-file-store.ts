import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import type { ChannelInstance } from './channel-types'

export type ChannelConfigMutationResult = { success: true } | { success: false; error: string }

/** Main-owned compatibility store for the legacy ~/.ola/plugins.json array. */
export class ChannelConfigFileStore {
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = join(olaDataRoot(), 'plugins.json')) {}

  async list(): Promise<ChannelInstance[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return Array.isArray(parsed) ? (parsed as ChannelInstance[]) : []
    } catch {
      return []
    }
  }

  async write(plugins: ChannelInstance[]): Promise<ChannelConfigMutationResult> {
    if (!Array.isArray(plugins)) return { success: false, error: 'Invalid channel plugin config' }
    return await this.enqueue(async () => {
      await writePlugins(this.filePath, plugins)
      return { success: true }
    })
  }

  async get(id: string): Promise<ChannelInstance | null> {
    if (!id.trim()) return null
    return (await this.list()).find((plugin) => plugin.id === id) ?? null
  }

  private async enqueue(
    change: () => Promise<ChannelConfigMutationResult>
  ): Promise<ChannelConfigMutationResult> {
    let result: ChannelConfigMutationResult = {
      success: false,
      error: 'Channel config write failed'
    }
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

async function writePlugins(path: string, plugins: ChannelInstance[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `plugins.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(plugins, null, 2), 'utf8')
  await rename(temporary, path)
}
