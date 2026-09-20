import { BrowserWindow, ipcMain } from 'electron'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { observeCodeGraphOperation, startCodeGraphSync } from '../lib/codegraph-sync'
import { TsCodeGraphService } from '../codegraph/ts-codegraph-service'
import { getWasmGrammarStatus, WASM_CODEGRAPH_LANGUAGES } from '../../runtime/codegraph/wasm-parser'

interface CodeGraphRequestArgs {
  method: string
  params?: unknown
  timeoutMs?: number
}

let tsService: TsCodeGraphService | null = null

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

export function getTsCodeGraphStatus(): {
  running: true
  workerReady: true
  workerPath: null
  grammarsDir: null
  grammarStatus: { expected: number; available: number; missing: string[] }
  generation: 1
  runtime: 'ts-wasm'
} {
  const available = WASM_CODEGRAPH_LANGUAGES.filter(
    (language) => getWasmGrammarStatus(language) === 'available'
  )
  return {
    running: true,
    workerReady: true,
    workerPath: null,
    grammarsDir: null,
    grammarStatus: {
      expected: WASM_CODEGRAPH_LANGUAGES.length,
      available: available.length,
      missing: WASM_CODEGRAPH_LANGUAGES.filter((language) => !available.includes(language))
    },
    generation: 1,
    runtime: 'ts-wasm'
  }
}

export async function requestCodeGraph(args: CodeGraphRequestArgs): Promise<unknown> {
  return await getTsCodeGraphService().request(args.method, args.params)
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export function registerCodeGraphHandlers(): void {
  void startCodeGraphSync()
  ipcMain.handle(toMessagePackChannel('codegraph:request'), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<CodeGraphRequestArgs>(bytes)
    if (!args.method?.startsWith('codegraph/')) {
      throw new Error('Only codegraph/* methods may use the TS CodeGraph service')
    }
    const result = await requestCodeGraph(args)
    observeCodeGraphOperation(args.method, args.params, result)
    return encodeMessagePackPayload(result)
  })
  ipcMain.handle(toMessagePackChannel('codegraph:status'), async () => {
    return encodeMessagePackPayload(getTsCodeGraphStatus())
  })
  ipcMain.handle(toMessagePackChannel('codegraph:stop'), async () => {
    await stopTsCodeGraphService()
    return encodeMessagePackPayload({ ok: true })
  })
  ipcMain.handle(toMessagePackChannel('codegraph:recycle'), async () => {
    await stopTsCodeGraphService()
    getTsCodeGraphService()
    return encodeMessagePackPayload({ ok: true })
  })
}
