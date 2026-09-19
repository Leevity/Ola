import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { olaDataRoot } from '../lib/ola-data-root'
import type { McpServerConfig } from './mcp-types'

export type McpMutationResult = { success: true } | { success: false; error: string }

export class McpConfigStore {
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = join(olaDataRoot(), 'mcp-servers.json')) {}

  async list(): Promise<McpServerConfig[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : []
    } catch {
      return []
    }
  }

  async get(id: string | undefined): Promise<{ server: McpServerConfig | null }> {
    if (!id?.trim()) return { server: null }
    return { server: (await this.list()).find((server) => server?.id === id) ?? null }
  }

  async add(config: McpServerConfig): Promise<McpMutationResult> {
    if (!isRecord(config)) return { success: false, error: 'Invalid MCP server config' }
    return await this.mutate((servers) => {
      servers.push(config)
      return { success: true }
    })
  }

  async update(id: string, patch: Partial<McpServerConfig>): Promise<McpMutationResult> {
    if (!id?.trim() || !isRecord(patch))
      return { success: false, error: 'Invalid MCP server update' }
    return await this.mutate((servers) => {
      const index = servers.findIndex((server) => server?.id === id)
      if (index < 0) return { success: false, error: 'Server not found' }
      servers[index] = { ...servers[index], ...patch }
      return { success: true }
    })
  }

  async remove(id: string): Promise<McpMutationResult> {
    if (!id?.trim()) return { success: false, error: 'Invalid MCP server id' }
    return await this.mutate((servers) => {
      const next = servers.filter((server) => server?.id !== id)
      if (next.length !== servers.length) servers.splice(0, servers.length, ...next)
      return { success: true }
    })
  }

  private async mutate(
    change: (servers: McpServerConfig[]) => McpMutationResult
  ): Promise<McpMutationResult> {
    let result: McpMutationResult = { success: false, error: 'MCP config write failed' }
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const servers = await this.list()
        result = change(servers)
        if (!result.success) return
        await atomicWriteJson(this.filePath, servers)
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

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = join(dirname(filePath), `mcp-servers.${randomUUID()}.tmp`)
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await rename(tempPath, filePath)
}
