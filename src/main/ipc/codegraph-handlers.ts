import { BrowserWindow, ipcMain } from 'electron'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import {
  getCodeGraphGrammarStatus,
  getCodeGraphWorker,
  resolveCodeGraphGrammarsDir,
  resolveCodeGraphWorkerPath
} from '../lib/codegraph-worker'
import { observeCodeGraphOperation, startCodeGraphSync } from '../lib/codegraph-sync'
import { TsCodeGraphService } from '../codegraph/ts-codegraph-service'

interface CodeGraphRequestArgs {
  method: string
  params?: unknown
  timeoutMs?: number
}

const RECOVERABLE_DASHBOARD_METHODS = new Set(['codegraph/index-status', 'codegraph/stats'])
let tsService: TsCodeGraphService | null = null

function isTsCodeGraphEnabled(): boolean {
  return process.env.OLA_CODEGRAPH_RUNTIME?.trim().toLowerCase() === 'ts'
}

function getTsCodeGraphService(): TsCodeGraphService {
  if (!tsService) {
    tsService = new TsCodeGraphService(undefined, (progress) =>
      broadcast('codegraph:index-progress', {
        indexId: progress.indexId,
        phase: progress.phase,
        processed: progress.filesDone,
        total: progress.filesTotal,
        nodeCount: progress.nodeCount,
        edgeCount: progress.edgeCount,
        message: progress.message,
        done: progress.phase === 'complete'
      })
    )
  }
  return tsService
}

async function stopTsCodeGraphService(): Promise<void> {
  const active = tsService
  tsService = null
  await active?.close()
}

function isStalledWorkerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('request timed out') || error.message === 'CodeGraph worker stopped'
}

async function requestCodeGraph(args: CodeGraphRequestArgs): Promise<unknown> {
  if (isTsCodeGraphEnabled()) return await getTsCodeGraphService().request(args.method, args.params)
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
  if (!isTsCodeGraphEnabled()) registerProgressForwarding()
  if (!isTsCodeGraphEnabled()) void startCodeGraphSync()
  ipcMain.handle(toMessagePackChannel('codegraph:request'), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<CodeGraphRequestArgs>(bytes)
    if (!args.method?.startsWith('codegraph/')) {
      throw new Error('Only codegraph/* methods may use the CodeGraph worker')
    }
    const result = await requestCodeGraph(args)
    observeCodeGraphOperation(args.method, args.params, result)
    return encodeMessagePackPayload(result)
  })
  ipcMain.handle(toMessagePackChannel('codegraph:status'), async () => {
    if (isTsCodeGraphEnabled()) {
      return encodeMessagePackPayload({
        running: true,
        workerReady: true,
        workerPath: null,
        grammarsDir: null,
        grammarStatus: { expected: 19, available: 19, missing: [] },
        generation: 1,
        runtime: 'ts-wasm'
      })
    }
    const worker = getCodeGraphWorker()
    const workerPath = resolveCodeGraphWorkerPath()
    const grammarsDir = workerPath ? resolveCodeGraphGrammarsDir(workerPath) : null
    const grammarStatus = getCodeGraphGrammarStatus(grammarsDir)
    return encodeMessagePackPayload({
      running: worker.isRunning,
      workerReady: workerPath !== null,
      workerPath,
      grammarsDir,
      grammarStatus,
      generation: worker.generation
    })
  })
  ipcMain.handle(toMessagePackChannel('codegraph:stop'), async () => {
    if (isTsCodeGraphEnabled()) {
      await stopTsCodeGraphService()
      return encodeMessagePackPayload({ ok: true })
    }
    await getCodeGraphWorker().stop()
    return encodeMessagePackPayload({ ok: true })
  })
  ipcMain.handle(toMessagePackChannel('codegraph:recycle'), async () => {
    if (isTsCodeGraphEnabled()) {
      await stopTsCodeGraphService()
      getTsCodeGraphService()
      return encodeMessagePackPayload({ ok: true })
    }
    await getCodeGraphWorker().recycle()
    return encodeMessagePackPayload({ ok: true })
  })
}
