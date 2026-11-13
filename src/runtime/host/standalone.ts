import { mkdtemp, writeFile, unlink, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { RunJournal } from '../storage/run-journal'
import { RunScheduler, type RunExecutor } from '../scheduler/run-scheduler'
import { RuntimeServer, type HostStreamSink, type RuntimeAuthority } from './runtime-server'
import { acquireServiceLease } from './service-lease'
import { RUNTIME_CONNECTION_DESCRIPTOR_VERSION, type RunSpec } from '../../shared/runtime/contracts'

/** The slice of the server an isolated executor needs to reach its host. */
export interface RuntimeHostChannel {
  requestHost<T>(method: string, params?: unknown, timeout?: number): Promise<T>
  registerHostStream(streamId: string, sink: HostStreamSink): () => void
}

export async function startStandaloneRuntime(options: {
  dataDirectory: string
  execute: RunExecutor
  authorize: (run: RunSpec) => Promise<void>
  authority: RuntimeAuthority
  /** Set only by the isolated child, whose host is Main. */
  allowHost?: boolean
}): Promise<{
  recordExternalArtifact: (
    spec: RunSpec,
    artifact: { path: string; mediaType: string }
  ) => Promise<void>
  endpoint: string
  token: string
  hostChannel: RuntimeHostChannel
  stop: () => Promise<void>
  revokeUnavailableWorkspaces: (availableIds: ReadonlySet<string>) => void
}> {
  const directory = join(options.dataDirectory, 'runtime-v2')
  const lease = await acquireServiceLease(directory)
  let journal: RunJournal | undefined,
    scheduler: RunScheduler | undefined,
    server: RuntimeServer | undefined
  let socketDirectory: string | undefined
  const descriptor = join(directory, 'connection.json')
  let descriptorWritten = false
  const token = randomBytes(32).toString('hex')
  const externalRecords = new Map<string, Promise<void>>()
  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> =>
    (stopPromise ??= (async () => {
      await server?.close()
      await scheduler?.stop()
      await journal?.close()
      if (descriptorWritten) {
        const current = await readFile(descriptor, 'utf8')
          .then((value) => JSON.parse(value) as { token?: string })
          .catch(() => null)
        if (current?.token === token) await unlink(descriptor).catch(() => undefined)
      }
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true })
      await lease.release()
    })())
  lease.signal.addEventListener(
    'abort',
    () => {
      void stop()
    },
    { once: true }
  )
  try {
    socketDirectory = process.platform === 'win32' ? undefined : await mkdtemp('/tmp/ola-runtime-')
    const endpoint = socketDirectory
      ? join(socketDirectory, 's')
      : `\\\\.\\pipe\\ola-runtime-${randomBytes(16).toString('hex')}`
    journal = new RunJournal(join(directory, 'runs.db'))
    scheduler = new RunScheduler(journal, options.execute, options.authorize)
    await scheduler.initialize()
    server = new RuntimeServer(scheduler, token, options.authority, {
      allowHost: options.allowHost
    })
    await server.listen(endpoint)
    await unlink(descriptor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await writeFile(
      descriptor,
      JSON.stringify({
        endpoint,
        token,
        pid: process.pid,
        version: RUNTIME_CONNECTION_DESCRIPTOR_VERSION
      }),
      { mode: 0o600, flag: 'wx' }
    )
    descriptorWritten = true
    return {
      recordExternalArtifact: async (spec, artifact) => {
        const key = `${spec.workspaceId}:${spec.runId}`
        const pending = (externalRecords.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            if (!(await options.authority.workspaceIds()).has(spec.workspaceId))
              throw new Error('WORKSPACE_FORBIDDEN')
            await journal!.recordExternalArtifact(spec, artifact)
          })
        externalRecords.set(key, pending)
        try {
          await pending
        } finally {
          if (externalRecords.get(key) === pending) externalRecords.delete(key)
        }
      },
      endpoint,
      token,
      hostChannel: server,
      stop,
      revokeUnavailableWorkspaces: (availableIds) => {
        // Pushed subscriptions must stop before the runs they describe do, so
        // a revoked workspace cannot keep receiving frames.
        server?.revokeUnavailableWorkspaces(availableIds)
        scheduler?.revokeUnavailableWorkspaces(availableIds)
      }
    }
  } catch (error) {
    await stop()
    throw error
  }
}
