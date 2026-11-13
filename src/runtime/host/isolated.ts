import { startIsolatedRuntime } from './isolated-runtime'

/**
 * utilityProcess entry point. The endpoint and token travel over the parent
 * port rather than a file so Main never has to guess whether a descriptor on
 * disk belongs to this process or to one that died before it.
 */
interface ParentPort {
  postMessage: (value: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => void
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
const dataDirectory = process.env.OLA_RUNTIME_DATA_DIRECTORY

let stop: (() => Promise<void>) | undefined

async function main(): Promise<void> {
  if (!dataDirectory) throw new Error('OLA_RUNTIME_DATA_DIRECTORY is required')
  const service = await startIsolatedRuntime(dataDirectory)
  stop = service.stop
  parentPort?.postMessage({ type: 'ready', endpoint: service.endpoint, token: service.token })
}

parentPort?.on('message', (event) => {
  const message = event.data as { type?: string } | null
  if (message?.type !== 'stop') return
  void (async () => {
    await stop?.().catch(() => undefined)
    parentPort.postMessage({ type: 'stopped' })
    process.exit(0)
  })()
})

void main().catch((error: unknown) => {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'RUNTIME_START_FAILED'
  console.error('[TsRuntime] isolated runtime failed to start', error)
  parentPort?.postMessage({ type: 'failed', code })
  process.exit(1)
})
