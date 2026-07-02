import { app, crashReporter } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import { getDataDir } from './db/database'

const LOG_DIR = join(getDataDir(), 'logs')
const NATIVE_CRASH_DUMPS_DIR = join(getDataDir(), 'crash-dumps')
const MAX_PAYLOAD_CHARS = 20_000
const MAX_OBJECT_KEYS = 80
const MAX_ARRAY_ITEMS = 50
const MAX_DEPTH = 4

type JsonRecord = Record<string, unknown>

let nativeCrashReporterStarted = false

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true })
}

function getLogFilePath(now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return join(LOG_DIR, `crash-${date}.log`)
}

function getAppVersionSafe(): string {
  try {
    return app.getVersion()
  } catch {
    return 'unknown'
  }
}

function normalizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth-exceeded]'
  if (value == null) return value

  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return String(value)
  if (value instanceof Error) {
    const out: JsonRecord = {
      name: value.name,
      message: value.message,
      stack: value.stack
    }
    const withCause = value as Error & { cause?: unknown }
    if (withCause.cause !== undefined) {
      out.cause = normalizeUnknown(withCause.cause, depth + 1)
    }
    return out
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeUnknown(item, depth + 1))
  }

  if (t === 'object') {
    const out: JsonRecord = {}
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)
    for (const [k, v] of entries) {
      out[k] = normalizeUnknown(v, depth + 1)
    }
    return out
  }

  return String(value)
}

function truncatePayload(payload: unknown): unknown {
  try {
    const raw = JSON.stringify(payload)
    if (raw.length <= MAX_PAYLOAD_CHARS) return payload
    return {
      truncated: true,
      totalChars: raw.length,
      preview: raw.slice(0, MAX_PAYLOAD_CHARS)
    }
  } catch {
    return payload
  }
}

export interface CrashLogEntry {
  timestamp: string
  event: string
  pid: number
  ppid: number
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  versions: {
    electron?: string
    node?: string
    chrome?: string
    v8?: string
  }
  payload?: unknown
}

export function writeCrashLog(event: string, payload?: unknown): void {
  try {
    ensureLogDir()
    const now = new Date()
    const entry: CrashLogEntry = {
      timestamp: now.toISOString(),
      event,
      pid: process.pid,
      ppid: process.ppid,
      appVersion: getAppVersionSafe(),
      platform: process.platform,
      osRelease: release(),
      versions: {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        v8: process.versions.v8
      },
      ...(payload === undefined ? {} : { payload: truncatePayload(normalizeUnknown(payload)) })
    }
    appendFileSync(getLogFilePath(now), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    console.error('[CrashLogger] Failed to write crash log:', err)
  }
}

export function getCrashLogDir(): string {
  return LOG_DIR
}

export function getNativeCrashDumpsDir(): string {
  return NATIVE_CRASH_DUMPS_DIR
}

export function startNativeCrashReporter(): void {
  if (nativeCrashReporterStarted) return

  let configuredCrashDumpsDir: string | null = null

  try {
    mkdirSync(NATIVE_CRASH_DUMPS_DIR, { recursive: true })
    app.setPath('crashDumps', NATIVE_CRASH_DUMPS_DIR)
    configuredCrashDumpsDir = NATIVE_CRASH_DUMPS_DIR
  } catch (error) {
    writeCrashLog('native_crash_dump_path_failed', { error })
  }

  try {
    crashReporter.start({
      productName: 'Ola',
      companyName: 'Ola',
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
      globalExtra: {
        platform: process.platform,
        arch: process.arch,
        packaged: String(app.isPackaged),
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? ''
      }
    })
    nativeCrashReporterStarted = true
    writeCrashLog('native_crash_reporter_started', {
      crashDumpsDir: configuredCrashDumpsDir ?? app.getPath('crashDumps'),
      uploadToServer: false
    })
  } catch (error) {
    writeCrashLog('native_crash_reporter_start_failed', { error })
  }
}
