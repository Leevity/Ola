import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeError, type RunSpec, type RuntimeCapability } from '../../shared/runtime/contracts'
import type { RuntimeClient } from '../../runtime/host/runtime-client'

/**
 * The child bundle is unpacked because it opens sibling SQLite Workers by file
 * URL, and a Worker cannot be loaded from inside an asar archive.
 */
function isolatedEntryPath(): string {
  const relative = join('out', 'runtime', 'isolated.mjs')
  if (app?.isPackaged) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', relative)
    return existsSync(unpacked) ? unpacked : join(process.resourcesPath, 'app.asar', relative)
  }
  // Electron is launched both as `electron .` and as `electron out/main/index.js`,
  // which report different app paths, so the child is located from this bundle
  // instead — the same convention the sibling SQLite Workers use.
  return fileURLToPath(new URL('../runtime/isolated.mjs', import.meta.url))
}

const READY_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const MAX_CONSECUTIVE_FAILURES = 5
const MAX_RESTART_DELAY_MS = 5_000
/**
 * Reaching `ready` is not success: a child that starts and dies immediately
 * would otherwise reset the counter and restart forever. Only staying up
 * clears the failure streak.
 */
const STABLE_AFTER_MS = 30_000

export interface IsolatedRuntimeService {
  endpoint: string
  token: string
  stop: () => Promise<void>
  revokeUnavailableWorkspaces: (availableIds: ReadonlySet<string>) => void
  recordExternalArtifact: (
    spec: RunSpec,
    artifact: { path: string; mediaType: string }
  ) => Promise<void>
}

export interface IsolatedRuntimeOptions {
  dataDirectory: string
  client: RuntimeClient
  capabilities: readonly RuntimeCapability[]
  /** A restarted child recovered its journal; every observer must reconcile. */
  onRestarted: () => void
  /** The connection is gone; no Main-side run state may survive it. */
  onDisconnected: () => void
  onUnavailable: (code: string) => void
}

/** True only inside Electron; tests and the CLI keep the in-process runtime. */
export function isolatedRuntimeSupported(): boolean {
  return typeof utilityProcess?.fork === 'function'
}

/**
 * Owns the Agent runtime process. A crash here costs the run, not the window:
 * the child's journal marks every unfinished run interrupted on the next start,
 * so nothing is silently lost and no side effect is replayed without review.
 */
export async function startIsolatedRuntimeService(
  options: IsolatedRuntimeOptions
): Promise<IsolatedRuntimeService> {
  let child: UtilityProcess | null = null
  let endpoint = ''
  let token = ''
  let stopping = false
  let failures = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null

  const spawn = async (): Promise<void> => {
    const started = utilityProcess.fork(isolatedEntryPath(), [], {
      env: { ...process.env, OLA_RUNTIME_DATA_DIRECTORY: options.dataDirectory },
      stdio: 'pipe',
      serviceName: 'Ola Agent Runtime'
    })
    child = started
    started.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    started.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    const ready = await new Promise<{ endpoint: string; token: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new RuntimeError('RUNTIME_START_TIMEOUT')),
        READY_TIMEOUT_MS
      )
      const onExit = (): void => finish(() => reject(new RuntimeError('RUNTIME_START_FAILED')))
      const onMessage = (message: unknown): void => {
        const frame = message as { type?: string; endpoint?: string; token?: string; code?: string }
        if (frame?.type === 'ready' && frame.endpoint && frame.token) {
          const { endpoint: readyEndpoint, token: readyToken } = frame
          finish(() => resolve({ endpoint: readyEndpoint, token: readyToken }))
        } else if (frame?.type === 'failed')
          finish(() => reject(new RuntimeError(frame.code ?? 'RUNTIME_START_FAILED')))
      }
      const finish = (action: () => void): void => {
        clearTimeout(timer)
        started.removeListener('exit', onExit)
        started.removeListener('message', onMessage)
        action()
      }
      started.once('exit', onExit)
      started.on('message', onMessage)
    })
    endpoint = ready.endpoint
    token = ready.token
    console.log(`[TsRuntime] isolated runtime ready (pid ${started.pid})`)
    if (stableTimer) clearTimeout(stableTimer)
    stableTimer = setTimeout(() => {
      failures = 0
      stableTimer = null
    }, STABLE_AFTER_MS)
    started.once('exit', () => {
      if (stableTimer) {
        clearTimeout(stableTimer)
        stableTimer = null
      }
      if (stopping || child !== started) return
      child = null
      options.client.close()
      options.onDisconnected()
      void restart()
    })
  }

  const restart = async (): Promise<void> => {
    if (stopping) return
    failures += 1
    if (failures > MAX_CONSECUTIVE_FAILURES) {
      options.onUnavailable('RUNTIME_UNAVAILABLE')
      return
    }
    const delay = Math.min(MAX_RESTART_DELAY_MS, 250 * 2 ** (failures - 1))
    await new Promise<void>((resolve) => {
      restartTimer = setTimeout(resolve, delay)
    })
    restartTimer = null
    if (stopping) return
    try {
      await spawn()
      await options.client.connect(endpoint, token, options.capabilities)
      options.onRestarted()
    } catch (error) {
      console.error('[TsRuntime] isolated runtime restart failed', error)
      child?.kill()
      child = null
      void restart()
    }
  }

  await spawn()
  await options.client.connect(endpoint, token, options.capabilities)

  return {
    get endpoint() {
      return endpoint
    },
    get token() {
      return token
    },
    stop: async () => {
      stopping = true
      if (restartTimer) clearTimeout(restartTimer)
      if (stableTimer) clearTimeout(stableTimer)
      const current = child
      child = null
      if (!current) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          current.kill()
          resolve()
        }, STOP_TIMEOUT_MS)
        current.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        current.postMessage({ type: 'stop' })
      })
    },
    revokeUnavailableWorkspaces: (availableIds) => {
      void options.client
        .request('host.workspace.revoke', { workspaceIds: [...availableIds] })
        .catch(() => undefined)
    },
    recordExternalArtifact: async (spec, artifact) => {
      await options.client.request('host.artifact.record', { spec, artifact }, 30_000)
    }
  }
}
