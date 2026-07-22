import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { safeStorage } from 'electron'
import {
  getBuiltInBrowserSession,
  listDetectedBrowserProfiles,
  type BrowserProfileCandidate
} from './browser-emulation'
import type { ConcreteBrowserUserDataSource } from '../../shared/browser-plugin'
import { decryptChromiumCbcCookie, decryptChromiumGcmCookie } from './chromium-cookie-crypto'

const execFileAsync = promisify(execFile)

export interface BrowserCookieProfile {
  id: string
  browserId: ConcreteBrowserUserDataSource
  browserName: string
  profileName: string
  profilePath: string
}

export interface BrowserCookieImportResult {
  success: boolean
  imported: number
  skipped: number
  failed: number
  errorKind?: 'browser_busy' | 'key_denied' | 'unsupported_database' | 'profile_missing'
  error?: string
}

interface ChromiumCookieRow {
  host_key: string
  name: string
  path: string
  encrypted_value: Buffer
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
}

function profileId(profile: BrowserProfileCandidate): string {
  return `${profile.browserId}:${basename(profile.profilePath)}`
}

export function listBrowserCookieProfiles(): BrowserCookieProfile[] {
  return listDetectedBrowserProfiles().map((profile) => ({
    id: profileId(profile),
    browserId: profile.browserId,
    browserName: profile.browserName,
    profileName: profile.profileDisplayName,
    profilePath: profile.profilePath
  }))
}

function cookieDatabasePath(profilePath: string): string {
  const networkPath = join(profilePath, 'Network', 'Cookies')
  return existsSync(networkPath) ? networkPath : join(profilePath, 'Cookies')
}

function safeStorageService(browserId: ConcreteBrowserUserDataSource): string {
  if (browserId === 'edge') return 'Microsoft Edge Safe Storage'
  if (browserId === 'brave') return 'Brave Safe Storage'
  if (browserId === 'chromium') return 'Chromium Safe Storage'
  return 'Chrome Safe Storage'
}

async function macPassword(browserId: ConcreteBrowserUserDataSource): Promise<string> {
  const { stdout } = await execFileAsync('security', [
    'find-generic-password',
    '-w',
    '-s',
    safeStorageService(browserId)
  ])
  return stdout.trim()
}

async function windowsKey(profile: BrowserProfileCandidate): Promise<Buffer> {
  const localState = JSON.parse(readFileSync(join(profile.dataRoot, 'Local State'), 'utf8')) as {
    os_crypt?: { encrypted_key?: unknown }
  }
  const encoded = localState.os_crypt?.encrypted_key
  if (typeof encoded !== 'string') throw new Error('Chromium encryption key is unavailable')
  const encryptedKey = Buffer.from(encoded, 'base64')
  const dpapiPayload =
    encryptedKey.subarray(0, 5).toString() === 'DPAPI' ? encryptedKey.subarray(5) : encryptedKey
  const script =
    'param([string]$blob) $bytes=[Convert]::FromBase64String($blob); ' +
    '$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Convert]::ToBase64String($plain)'
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
    dpapiPayload.toString('base64')
  ])
  return Buffer.from(stdout.trim(), 'base64')
}

async function decryptCookie(
  row: ChromiumCookieRow,
  macKey: string | null,
  winKey: Buffer | null
): Promise<string> {
  const encrypted = Buffer.from(row.encrypted_value)
  const version = encrypted.subarray(0, 3).toString()
  if (version === 'v20') throw new Error('App-bound cookie encryption is not supported')
  if (process.platform === 'win32') {
    if (!winKey) throw new Error('Windows cookie key is unavailable')
    return decryptChromiumGcmCookie(encrypted, winKey, row.host_key)
  }
  if (version !== 'v10' && version !== 'v11') {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(encrypted)
    throw new Error('Cookie encryption format is not supported')
  }
  return decryptChromiumCbcCookie(
    encrypted,
    process.platform === 'darwin' ? (macKey ?? '') : 'peanuts',
    row.host_key,
    process.platform === 'darwin' ? 1003 : 1
  )
}

function chromiumTimestampToUnixSeconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.max(0, value / 1_000_000 - 11_644_473_600)
}

function sameSite(value: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (value === 0) return 'no_restriction'
  if (value === 1) return 'lax'
  if (value === 2) return 'strict'
  return 'unspecified'
}

export async function importBrowserCookies(
  profileIdValue: string
): Promise<BrowserCookieImportResult> {
  const profile = listDetectedBrowserProfiles().find(
    (candidate) => profileId(candidate) === profileIdValue
  )
  if (!profile) {
    return { success: false, imported: 0, skipped: 0, failed: 0, errorKind: 'profile_missing' }
  }

  const sourcePath = cookieDatabasePath(profile.profilePath)
  const tempDir = await mkdtemp(join(tmpdir(), 'ola-cookie-import-'))
  const copyPath = join(tempDir, 'Cookies')
  let database: Database.Database | null = null
  try {
    await copyFile(sourcePath, copyPath)
    for (const suffix of ['-wal', '-shm']) {
      const companion = `${sourcePath}${suffix}`
      if (existsSync(companion)) await copyFile(companion, `${copyPath}${suffix}`)
    }
    database = new Database(copyPath, { readonly: true, fileMustExist: true })
    const rows = database
      .prepare(
        'SELECT host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly, samesite FROM cookies'
      )
      .all() as ChromiumCookieRow[]
    const macKey = process.platform === 'darwin' ? await macPassword(profile.browserId) : null
    const winKey = process.platform === 'win32' ? await windowsKey(profile) : null
    const targetSession = getBuiltInBrowserSession()
    let imported = 0
    let skipped = 0
    let failed = 0

    for (const row of rows) {
      try {
        const value = await decryptCookie(row, macKey, winKey)
        if (!row.name || !row.host_key || !value) {
          skipped += 1
          continue
        }
        const host = row.host_key.replace(/^\./u, '')
        await targetSession.cookies.set({
          url: `${row.is_secure ? 'https' : 'http'}://${host}${row.path || '/'}`,
          domain: row.host_key,
          name: row.name,
          value,
          path: row.path || '/',
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          sameSite: sameSite(row.samesite),
          expirationDate: chromiumTimestampToUnixSeconds(row.expires_utc)
        })
        imported += 1
      } catch {
        failed += 1
      }
    }
    await targetSession.cookies.flushStore()
    return { success: true, imported, skipped, failed }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const errorKind = /permission|denied|keychain|encryption key/iu.test(message)
      ? 'key_denied'
      : /busy|locked|resource/iu.test(message)
        ? 'browser_busy'
        : 'unsupported_database'
    return { success: false, imported: 0, skipped: 0, failed: 0, errorKind, error: message }
  } finally {
    database?.close()
    await rm(tempDir, { recursive: true, force: true })
  }
}
