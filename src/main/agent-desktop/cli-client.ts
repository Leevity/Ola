import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { agentDesktopTripleKey } from './detector'

const MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 256 * 1024
const MAX_CONCURRENT_CALLS = 4

export type AgentDesktopPermissionState = 'granted' | 'denied' | 'unknown'

export type AgentDesktopStatusPayload = {
  platform: string | null
  version: string | null
  stateRoot: string | null
  accessibility: AgentDesktopPermissionState
  supportedSurfaces: string[]
}

type RawEnvelope = {
  version?: unknown
  ok?: unknown
  command?: unknown
  data?: Record<string, unknown>
  error?: {
    code?: unknown
    message?: unknown
    disposition?: unknown
    suggestion?: unknown
  }
}

export type AgentDesktopDisposal = {
  delivery: string | null
  retry: string | null
}

export type AgentDesktopReply = {
  ok: boolean
  /** Upstream error code, or a client-side code when the process itself failed. */
  code: string | null
  message: string | null
  suggestion: string | null
  data: Record<string, unknown>
  disposition: AgentDesktopDisposal
  exitCode: number | null
}

export class AgentDesktopTrustError extends Error {
  name = 'AgentDesktopTrustError'
}

/**
 * `status` answers two questions Ola cannot answer about itself: whether the OS handed this
 * process the accessibility entitlement, and which surfaces the adapter can actually read.
 */
export function parseAgentDesktopStatus(
  envelope: AgentDesktopReply
): AgentDesktopStatusPayload | null {
  if (!envelope.ok) return null
  const permissions = envelope.data.permissions as Record<string, unknown> | undefined
  const accessibility = (permissions?.accessibility as { state?: string } | undefined)?.state
  return {
    platform: typeof envelope.data.platform === 'string' ? envelope.data.platform : null,
    version: typeof envelope.data.version === 'string' ? envelope.data.version : null,
    stateRoot: typeof envelope.data.state_root === 'string' ? envelope.data.state_root : null,
    accessibility:
      accessibility === 'granted' || accessibility === 'denied' ? accessibility : 'unknown',
    supportedSurfaces: Array.isArray(envelope.data.supported_surfaces)
      ? envelope.data.supported_surfaces.filter((item): item is string => typeof item === 'string')
      : []
  }
}

function disposalFrom(value: unknown): AgentDesktopDisposal {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    delivery: typeof record.delivery === 'string' ? record.delivery : null,
    retry: typeof record.retry === 'string' ? record.retry : null
  }
}

function failureReply(
  code: string,
  message: string | null,
  disposition: AgentDesktopDisposal,
  exitCode: number | null = null,
  suggestion: string | null = null
): AgentDesktopReply {
  return { ok: false, code, message, suggestion, data: {}, disposition, exitCode }
}

export function parseAgentDesktopEnvelope(stdout: string): AgentDesktopReply {
  let parsed: RawEnvelope
  try {
    parsed = JSON.parse(stdout) as RawEnvelope
  } catch {
    return failureReply('AGENT_DESKTOP_BAD_ENVELOPE', null, { delivery: null, retry: null })
  }
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {}
  if (parsed.ok === true) {
    return {
      ok: true,
      code: null,
      message: null,
      suggestion: null,
      data,
      disposition: disposalFrom(data.disposition),
      exitCode: 0
    }
  }
  const error = parsed.error ?? {}
  return {
    ok: false,
    code: typeof error.code === 'string' ? error.code : 'INTERNAL',
    message: typeof error.message === 'string' ? error.message : null,
    suggestion: typeof error.suggestion === 'string' ? error.suggestion : null,
    data,
    disposition: disposalFrom(error.disposition ?? data.disposition),
    exitCode: 1
  }
}

function lockPathCandidates(): string[] {
  const relative = join('resources', 'agent-desktop.lock.json')
  if (app?.isPackaged) {
    return [
      join(process.resourcesPath, 'app.asar.unpacked', relative),
      join(process.resourcesPath, relative)
    ]
  }
  return [join(app?.getAppPath?.() ?? process.cwd(), relative)]
}

let pinnedHashes: { loaded: boolean; pins: Record<string, string> } | null = null

async function readPinnedBinaryHash(): Promise<Record<string, string>> {
  if (pinnedHashes?.loaded) return pinnedHashes.pins
  for (const candidate of lockPathCandidates()) {
    let raw: string
    try {
      raw = await readFile(candidate, 'utf8')
    } catch {
      continue
    }
    const lock = JSON.parse(raw) as {
      platforms: Record<string, { binaries: Record<string, { sha256: string }> }>
    }
    const entry = lock.platforms[agentDesktopTripleKey(process.platform, process.arch)]
    pinnedHashes = {
      loaded: true,
      pins: Object.fromEntries(
        Object.entries(entry?.binaries ?? {}).map(([name, pin]) => [name, pin.sha256])
      )
    }
    return pinnedHashes.pins
  }
  return {}
}

type TrustCache = { fingerprint: string; hash: string }
const trustCache = new Map<string, TrustCache>()

/**
 * The binary is pinned at build time, so a runtime mismatch means the shipped file changed on
 * disk. Refuse to execute rather than run whatever replaced it.
 */
export async function verifyAgentDesktopTrust(
  binaryPath: string,
  options: { pinned: boolean }
): Promise<void> {
  if (!isAbsolute(binaryPath)) {
    throw new AgentDesktopTrustError('agent-desktop path must be absolute')
  }
  let info
  try {
    info = await stat(binaryPath)
  } catch {
    throw new AgentDesktopTrustError('agent-desktop binary is missing')
  }
  if (!info.isFile()) throw new AgentDesktopTrustError('agent-desktop binary is not a file')
  if (process.platform !== 'win32') {
    try {
      await access(binaryPath, fsConstants.X_OK)
    } catch {
      throw new AgentDesktopTrustError('agent-desktop binary is not executable')
    }
  }
  const fingerprint = `${info.size}:${Math.round(info.mtimeMs)}`
  const cached = trustCache.get(binaryPath)
  if (cached && cached.fingerprint === fingerprint) {
    await assertPinned(binaryPath, cached.hash, options.pinned)
    return
  }
  const hash = createHash('sha256')
    .update(await readFile(binaryPath))
    .digest('hex')
  trustCache.set(binaryPath, { fingerprint, hash })
  await assertPinned(binaryPath, hash, options.pinned)
}

async function assertPinned(path: string, hash: string, pinned: boolean): Promise<void> {
  if (!pinned) return
  const pins = await readPinnedBinaryHash()
  const expected = pins[binaryNameOf(path)]
  if (!expected) {
    throw new AgentDesktopTrustError(`agent-desktop binary is not pinned: ${binaryNameOf(path)}`)
  }
  if (expected !== hash) throw new AgentDesktopTrustError('agent-desktop binary hash changed')
}

function binaryNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function agentDesktopEnv(
  processEnv: NodeJS.ProcessEnv,
  sessionEnv: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {}
  // The CLI needs the desktop session's own coordinates; a stripped env cannot see a display.
  const forward = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'XDG_RUNTIME_DIR',
    'XDG_DATA_DIRS',
    'XDG_CONFIG_HOME',
    'XDG_SESSION_TYPE',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SYSTEMDRIVE',
    'DRIVE_HOME'
  ]
  for (const key of forward) {
    const value = processEnv[key]
    if (typeof value === 'string' && value.length) env[key] = value
  }
  return { ...env, ...sessionEnv }
}

let inFlight = 0
const queue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_CALLS) {
    inFlight += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    queue.push(() => {
      inFlight += 1
      resolve()
    })
  })
}

function releaseSlot(): void {
  inFlight -= 1
  queue.shift()?.()
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const signalTree = (signal: NodeJS.Signals): void => {
    if (process.platform === 'win32') {
      if (child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
        killer.unref()
      }
      return
    }
    if (!child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  signalTree('SIGTERM')
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL')
  }, 1_000)
  escalation.unref()
}

export type AgentDesktopRunInput = {
  binaryPath: string
  argv: string[]
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  pinned: boolean
}

/**
 * One spawn, one result. Timeouts, overflows and unparseable output become replies instead of
 * exceptions so the caller never mistakes a failed call for a reason to escalate privileges.
 */
export async function runAgentDesktop(input: AgentDesktopRunInput): Promise<AgentDesktopReply> {
  try {
    await verifyAgentDesktopTrust(input.binaryPath, { pinned: input.pinned })
  } catch (error) {
    if (!(error instanceof AgentDesktopTrustError)) throw error
    return failureReply(
      'AGENT_DESKTOP_TRUST_CHECK_FAILED',
      'The pinned agent-desktop binary failed its integrity check, so it was not started. Reinstall Ola.',
      { delivery: null, retry: null }
    )
  }
  if (input.signal.aborted) {
    return failureReply('CANCELED', null, { delivery: null, retry: null })
  }

  await acquireSlot()
  try {
    return await spawnOnce(input)
  } finally {
    releaseSlot()
  }
}

async function spawnOnce(input: AgentDesktopRunInput): Promise<AgentDesktopReply> {
  return new Promise((resolve) => {
    const child = spawn(input.binaryPath, input.argv, {
      env: agentDesktopEnv(process.env, input.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let overflow = false
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      terminate(child)
    }, input.timeoutMs)
    const abort = (): void => {
      terminate(child)
    }
    input.signal.addEventListener('abort', abort, { once: true })
    const finish = (reply: AgentDesktopReply): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      resolve(reply)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = concat(stdout, chunk, MAX_STDOUT_BYTES, () => {
        overflow = true
        terminate(child)
      })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = concat(stderr, chunk, MAX_STDERR_BYTES, () => {})
    })
    child.on('error', () => {
      finish(failureReply('AGENT_DESKTOP_SPAWN_FAILED', null, { delivery: null, retry: null }))
    })
    child.on('close', (code, signal) => {
      if (timedOut) {
        // A silent timeout cannot prove the action never landed, so it is never retry-safe.
        finish(
          failureReply(
            'TIMEOUT',
            null,
            { delivery: 'unknown', retry: 'unsafe' },
            code,
            'Re-snapshot to learn the real state before acting again.'
          )
        )
        return
      }
      if (overflow) {
        // Truncating a snapshot silently would hand the model a tree with missing branches.
        finish(
          failureReply(
            'AGENT_DESKTOP_OUTPUT_TOO_LARGE',
            null,
            { delivery: 'unknown', retry: 'unsafe' },
            code,
            'Narrow the capture with maxDepth, a root ref, or interactive-only mode.'
          )
        )
        return
      }
      const text = stdout.toString('utf8').trim()
      if (!text) {
        finish(
          failureReply(
            signal ? 'CANCELED' : 'AGENT_DESKTOP_EMPTY_RESULT',
            stderr.toString('utf8').slice(0, 400) || null,
            { delivery: null, retry: null },
            code
          )
        )
        return
      }
      const reply = parseAgentDesktopEnvelope(text)
      if (!reply.ok && reply.code === 'AGENT_DESKTOP_BAD_ENVELOPE' && code === 2) {
        reply.code = 'INVALID_ARGS'
      }
      reply.exitCode = code
      finish(reply)
    })
  })
}

function concat(current: Buffer, chunk: Buffer, limit: number, onOverflow: () => void): Buffer {
  if (current.byteLength + chunk.byteLength > limit) {
    onOverflow()
    return current
  }
  return Buffer.concat([current, chunk])
}

/**
 * The single retry entrance: only a delivery the CLI itself declares safe. `delivered_unverified`
 * is never retried, because re-pressing a button that already worked double-fires it.
 */
export function mayRetrySafely(reply: AgentDesktopReply): boolean {
  return !reply.ok && reply.disposition.retry === 'safe'
}

export function agentDesktopFailure(reply: AgentDesktopReply): string {
  const parts = [`agent-desktop ${reply.code ?? 'ERROR'}`]
  if (reply.message) parts.push(reply.message)
  if (reply.disposition.delivery) parts.push(`delivery=${reply.disposition.delivery}`)
  if (reply.disposition.retry) parts.push(`retry=${reply.disposition.retry}`)
  if (reply.suggestion) parts.push(reply.suggestion)
  return parts.join(': ')
}
