import { BrowserWindow, ipcMain } from 'electron'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { getCodeGraphWorker, resolveCodeGraphWorkerPath } from '../lib/codegraph-worker'

interface CodeGraphRequestArgs {
  method: string
  params?: unknown
  timeoutMs?: number
}

const RECOVERABLE_DASHBOARD_METHODS = new Set(['codegraph/index-status', 'codegraph/stats'])

function isStalledWorkerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('request timed out') || error.message === 'CodeGraph worker stopped'
}

async function requestCodeGraph(args: CodeGraphRequestArgs): Promise<unknown> {
  const worker = getCodeGraphWorker()
  try {
    return await worker.request(args.method, args.params, args.timeoutMs)
  } catch (error) {
    if (!RECOVERABLE_DASHBOARD_METHODS.has(args.method) || !isStalledWorkerError(error)) {
      throw error
    }

    console.warn('[CodeGraphWorker] recycling stalled dashboard request', {
      method: args.method,
      error: error instanceof Error ? error.message : String(error)
    })
    await worker.stop()
    return await worker.request(args.method, args.params, args.timeoutMs)
  }
}

let forwardingRegistered = false

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function registerProgressForwarding(): void {
  if (forwardingRegistered) return
  forwardingRegistered = true
  const worker = getCodeGraphWorker()
  worker.onEvent('codegraph/index-progress', (payload) =>
    broadcast('codegraph:index-progress', payload)
  )
  worker.onEvent('codegraph/index-complete', (payload) =>
    broadcast('codegraph:index-progress', {
      ...(payload && typeof payload === 'object' ? payload : {}),
      done: true
    })
  )
}

export function registerCodeGraphHandlers(): void {
  registerProgressForwarding()
  ipcMain.handle(toMessagePackChannel('codegraph:request'), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<CodeGraphRequestArgs>(bytes)
    if (!args.method?.startsWith('codegraph/')) {
      throw new Error('Only codegraph/* methods may use the CodeGraph worker')
    }
    const result = await requestCodeGraph(args)
    return encodeMessagePackPayload(result)
  })
  ipcMain.handle(toMessagePackChannel('codegraph:status'), async () => {
    const worker = getCodeGraphWorker()
    return encodeMessagePackPayload({
      running: worker.isRunning,
      workerReady: resolveCodeGraphWorkerPath() !== null
    })
  })
  ipcMain.handle(toMessagePackChannel('codegraph:stop'), async () => {
    await getCodeGraphWorker().stop()
    return encodeMessagePackPayload({ ok: true })
  })
  ipcMain.handle(toMessagePackChannel('codegraph:recycle'), async () => {
    await getCodeGraphWorker().recycle()
    return encodeMessagePackPayload({ ok: true })
  })
}
