import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { SettingsStore } from '../settings/settings-store'
import type { SyncRecord } from '../../shared/sync-types'

const SETTINGS_FILE = 'settings.json'
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'password',
  'passphrase',
  'secret',
  'clientsecret',
  'client_secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'bearertoken',
  'bearer_token',
  'sessiontoken',
  'session_token',
  'idtoken',
  'id_token',
  'authorization',
  'privatekey',
  'private_key',
  'credentials',
  'encryptedpassword',
  'encrypted_password',
  'webdavpassword',
  'webdav_password'
])

export class SyncFileStore {
  constructor(
    private readonly settings = new SettingsStore(join(olaDataRoot(), SETTINGS_FILE)),
    private readonly settingsPath = join(olaDataRoot(), SETTINGS_FILE)
  ) {}

  async capture(): Promise<SyncRecord[]> {
    try {
      const raw = await readFile(this.filePath(), 'utf8')
      const value = parseRecord(raw)
      if (!value) throw new Error('Invalid settings sync file')
      removeSensitiveValues(value)
      const data = Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64')
      return [
        {
          domain: 'file',
          recordId: SETTINGS_FILE,
          hash: hash({ path: SETTINGS_FILE, data }),
          value: { path: SETTINGS_FILE, data },
          updatedAt: await this.settingsMtime()
        }
      ]
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async apply(records: SyncRecord[]): Promise<{ changed: number; settingsChanged: boolean }> {
    let changed = 0
    for (const record of records) {
      if (record.domain !== 'file') continue
      const path = recordPath(record)
      if (path !== SETTINGS_FILE)
        throw new Error(`Refusing to write unsupported sync file: ${path}`)
      const data = recordData(record)
      const next = parseRecord(Buffer.from(data, 'base64').toString('utf8'))
      if (!next) throw new Error('Invalid settings sync file')
      preserveLocalSensitiveValues(next, await this.settings.read())
      const result = await this.settings.write(next)
      if (!result.success) throw new Error(result.error)
      changed += 1
    }
    return { changed, settingsChanged: changed > 0 }
  }

  async delete(recordIds: string[]): Promise<{ changed: number; settingsChanged: boolean }> {
    let changed = 0
    for (const id of recordIds) {
      if (normalizePath(id) !== SETTINGS_FILE) continue
      try {
        await rm(this.filePath())
        changed += 1
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return { changed, settingsChanged: changed > 0 }
  }

  private filePath(): string {
    return this.settingsPath
  }

  private async settingsMtime(): Promise<number> {
    try {
      return (await stat(this.filePath())).mtimeMs
    } catch {
      return Date.now()
    }
  }
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
function recordPath(record: SyncRecord): string {
  return record.value &&
    typeof record.value === 'object' &&
    typeof (record.value as { path?: unknown }).path === 'string'
    ? normalizePath((record.value as { path: string }).path)
    : normalizePath(record.recordId)
}
function recordData(record: SyncRecord): string {
  const data =
    record.value && typeof record.value === 'object'
      ? (record.value as { data?: unknown }).data
      : undefined
  return typeof data === 'string' ? data : ''
}
function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}
function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(row[key])}`)
    .join(',')}}`
}
function removeSensitiveValues(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeSensitiveValues)
    return
  }
  if (!value || typeof value !== 'object') return
  const row = value as Record<string, unknown>
  for (const key of Object.keys(row)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) delete row[key]
    else removeSensitiveValues(row[key])
  }
}
function preserveLocalSensitiveValues(next: unknown, local: unknown): void {
  if (Array.isArray(next) && Array.isArray(local)) {
    next.forEach((value, index) => preserveLocalSensitiveValues(value, local[index]))
    return
  }
  if (
    !next ||
    !local ||
    typeof next !== 'object' ||
    typeof local !== 'object' ||
    Array.isArray(next) ||
    Array.isArray(local)
  )
    return
  const target = next as Record<string, unknown>
  for (const [key, value] of Object.entries(local as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) target[key] = structuredClone(value)
    else if (key in target) preserveLocalSensitiveValues(target[key], value)
  }
}
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}
