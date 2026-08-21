import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

export type CredentialAuditAction = 'store' | 'update' | 'delete' | 'resolve' | 'inject' | 'verify'

export interface CredentialAuditEntry {
  id: string
  action: CredentialAuditAction
  credentialId?: string
  domain?: string
  actor: 'main' | 'renderer' | 'agent' | 'remote'
  success: boolean
  error?: string
  createdAt: number
}

const MAX_ENTRIES = 500

function auditPath(): string {
  const directory = join(app.getPath('userData'), 'credentials')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return join(directory, 'audit.json')
}

function readEntries(): CredentialAuditEntry[] {
  try {
    const raw = readFileSync(auditPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as CredentialAuditEntry[]) : []
  } catch {
    return []
  }
}

function writeEntries(entries: CredentialAuditEntry[]): void {
  const target = auditPath()
  const temporary = `${target}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
  renameSync(temporary, target)
}

function safeError(error?: string): string | undefined {
  if (!error) return undefined
  return error.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 500)
}

export function recordCredentialAudit(input: Omit<CredentialAuditEntry, 'id' | 'createdAt'>): void {
  try {
    const entries = readEntries()
    entries.push({
      ...input,
      error: safeError(input.error),
      id: randomUUID(),
      createdAt: Date.now()
    })
    writeEntries(entries)
  } catch (error) {
    console.warn('[CredentialAudit] failed to persist audit entry:', error)
  }
}

export function listCredentialAudit(limit = 100): CredentialAuditEntry[] {
  return readEntries()
    .slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)))
    .reverse()
}
