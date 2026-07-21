import { app, crashReporter } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { release } from 'os'
import { join } from 'path'
import { getDataDir } from './db/database'

const LOG_DIR = join(getDataDir(), 'logs')
const NATIVE_CRASH_DUMPS_DIR = join(getDataDir(), 'crash-dumps')
const MAX_PAYLOAD_CHARS = 20_000
const MAX_OBJECT_KEYS = 80
const MAX_ARRAY_ITEMS = 50
const MAX_DEPTH = 4
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
const MAX_LOG_FILES = 7
const MAX_TOTAL_LOG_BYTES = 50 * 1024 * 1024
const DUPLICATE_WINDOW_MS = 5_000

type JsonRecord = Record<string, unknown>

let nativeCrashReporterStarted = false
let crashLogWriteInProgress = false
let lastLogSignature = ''
let lastLogTimestamp = 0

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true })
}

function getLogFilePath(now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return join(LOG_DIR, `crash-${date}.log`)
}

function getRotatedLogFilePath(now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return join(LOG_DIR, `crash-${date}-${now.getTime()}.log`)
}

function pruneCrashLogs(): void {
  const logs = readdirSync(LOG_DIR)
    .filter((name) => /^crash-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/.test(name))
    .map((name) => {
      const path = join(LOG_DIR, name)
      const stats = statSync(path)
      return { path, size: stats.size, modifiedAt: stats.mtimeMs }
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt)

  let retainedBytes = 0
  for (const [index, log] of logs.entries()) {
    retainedBytes += log.size
    if (index >= MAX_LOG_FILES || retainedBytes > MAX_TOTAL_LOG_BYTES) {
      unlinkSync(log.path)
    }
  }
}

function rotateLogIfNeeded(path: string, incomingBytes: number, now: Date): void {
  if (!existsSync(path)) return
  if (statSync(path).size + incomingBytes <= MAX_LOG_FILE_BYTES) return

  renameSync(path, getRotatedLogFilePath(now))
  pruneCrashLogs()
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
  if (crashLogWriteInProgress) return

  crashLogWriteInProgress = true
  try {
    ensureLogDir()
    const now = new Date()
    const normalizedPayload =
      payload === undefined ? undefined : truncatePayload(normalizeUnknown(payload))
    const signature = `${event}:${JSON.stringify(normalizedPayload)}`
    if (signature === lastLogSignature && now.getTime() - lastLogTimestamp < DUPLICATE_WINDOW_MS) {
      return
    }
    lastLogSignature = signature
    lastLogTimestamp = now.getTime()

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
      ...(normalizedPayload === undefined ? {} : { payload: normalizedPayload })
    }
    const serializedEntry = `${JSON.stringify(entry)}\n`
    const logPath = getLogFilePath(now)
    rotateLogIfNeeded(logPath, Buffer.byteLength(serializedEntry), now)
    appendFileSync(logPath, serializedEntry, { encoding: 'utf8', mode: 0o600 })
    pruneCrashLogs()
  } catch {
    // Never report a crash-log failure through console or the global error handlers:
    // stderr and the log filesystem may be the source of the original failure.
  } finally {
    crashLogWriteInProgress = false
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
