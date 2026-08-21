import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

export interface RemoteAuditEntry {
  id: string
  action: 'connect' | 'disconnect' | 'input_enable' | 'input' | 'input_disable'
  sessionId?: string
  ownerWebContentsId?: number
  success: boolean
  error?: string
  createdAt: number
}

const MAX_ENTRIES = 500

function auditPath(): string {
  const directory = join(app.getPath('userData'), 'remote')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return join(directory, 'audit.json')
}

function readEntries(): RemoteAuditEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(auditPath(), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as RemoteAuditEntry[]) : []
  } catch {
    return []
  }
}

export function recordRemoteAudit(input: Omit<RemoteAuditEntry, 'id' | 'createdAt'>): void {
  try {
    const entries = readEntries()
    entries.push({ ...input, id: randomUUID(), createdAt: Date.now() })
    const target = auditPath()
    const temporary = `${target}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporary, target)
  } catch (error) {
    console.warn('[RemoteAudit] failed to persist audit entry:', error)
  }
}

export function listRemoteAudit(limit = 100): RemoteAuditEntry[] {
  return readEntries()
    .slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)))
    .reverse()
}
