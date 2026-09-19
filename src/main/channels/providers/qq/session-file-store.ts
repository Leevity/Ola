import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { olaDataRoot } from '../../../lib/ola-data-root'
import type { SessionState } from './session-store'

const SESSION_EXPIRE_MS = 5 * 60 * 1000
const MAX_SESSION_BYTES = 16 * 1024

export function qqSessionAccountKey(workspaceId: string, pluginId: string): string {
  if (!workspaceId || workspaceId !== workspaceId.trim() || workspaceId.length > 1024)
    throw new Error('INVALID_QQ_SESSION_WORKSPACE')
  if (!pluginId || pluginId !== pluginId.trim() || pluginId.length > 1024)
    throw new Error('INVALID_QQ_SESSION_PLUGIN')
  return createHash('sha256')
    .update('ola-qq-session-v2\0')
    .update(workspaceId)
    .update('\0')
    .update(pluginId)
    .digest('hex')
}

function validAccountKey(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId)
}

export class QqSessionFileStore {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly directory = join(olaDataRoot(), 'qq-bot', 'sessions'),
    private readonly now: () => number = Date.now
  ) {}

  async load(accountId: string): Promise<SessionState | null> {
    const path = this.path(accountId)
    await this.pending.get(accountId)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_BYTES) return null
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const value = raw as Record<string, unknown>
      if (
        value.accountId !== accountId ||
        typeof value.sessionId !== 'string' ||
        !value.sessionId ||
        !Number.isSafeInteger(value.lastSeq) ||
        !Number.isSafeInteger(value.savedAt) ||
        Number(value.savedAt) <= 0 ||
        Number(value.savedAt) > this.now() ||
        this.now() - Number(value.savedAt) > SESSION_EXPIRE_MS
      )
        return null
      return value as unknown as SessionState
    } catch {
      return null
    }
  }

  async save(state: SessionState): Promise<void> {
    const path = this.path(state.accountId)
    if (
      typeof state.sessionId !== 'string' ||
      !state.sessionId ||
      !Number.isSafeInteger(state.lastSeq) ||
      !Number.isInteger(state.intentLevelIndex)
    )
      throw new Error('INVALID_QQ_SESSION_STATE')
    await this.enqueue(state.accountId, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = join(this.directory, `session-${state.accountId}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify({ ...state, savedAt: this.now() }), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx'
        })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  async clear(accountId: string): Promise<void> {
    const path = this.path(accountId)
    await this.enqueue(accountId, async () => {
      await rm(path, { force: true })
    })
  }

  private path(accountId: string): string {
    if (!validAccountKey(accountId)) throw new Error('INVALID_QQ_SESSION_ACCOUNT')
    return join(this.directory, `session-${accountId}.json`)
  }

  private async enqueue(accountId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(accountId)
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.pending.set(accountId, current)
    try {
      await current
    } finally {
      if (this.pending.get(accountId) === current) this.pending.delete(accountId)
    }
  }
}
