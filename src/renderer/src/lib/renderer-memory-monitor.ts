import type { ContentBlock, UnifiedMessage } from './api/types'
import { compactRequestDebugStore, getRequestDebugStoreStats } from './debug-store'
import { useChatStore } from '../stores/chat-store'
import { useAgentStore } from '../stores/agent-store'
import { useSettingsStore } from '../stores/settings-store'
import { toast } from 'sonner'
import { invokeMessagePackBinary } from './ipc/messagepack-ipc-client'
import { DIAGNOSTICS_MEMORY_SAMPLE_MSGPACK_CHANNEL } from '../../../shared/messagepack/binary-ipc'

const RENDERER_MEMORY_SAMPLE_MS = 60_000
const RENDERER_MEMORY_INITIAL_DELAY_MS = 10_000
const WARN_USED_JS_HEAP_BYTES = 512 * 1024 * 1024
const SOFT_USED_JS_HEAP_BYTES = 700 * 1024 * 1024
const HARD_USED_JS_HEAP_BYTES = 1.2 * 1024 * 1024 * 1024
const WARN_RESIDENT_CONTENT_CHARS = 64 * 1024 * 1024
const SOFT_RESIDENT_CONTENT_CHARS = 128 * 1024 * 1024
const MEMORY_PRESSURE_COOLDOWN_MS = 30_000

type ChromiumPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

interface ProcessMemoryDiagnostics {
  sampledAt: number
  main: {
    pid: number
    memory: {
      rss: number
      heapTotal: number
      heapUsed: number
      external: number
      arrayBuffers: number
    }
  }
  appMetrics: Array<{
    pid: number
    type: string
    memory: {
      workingSetKb?: number
      peakWorkingSetKb?: number
      privateKb?: number
      sharedKb?: number
    } | null
  }>
  nativeWorker: {
    success?: boolean
    pid?: number | null
    managedBytes?: number
    heapBytes?: number
    fragmentedBytes?: number
    workingSetBytes?: number
    error?: string | null
  } | null
}

let installed = false
let reducedMemoryMode = false
let lastMemoryPressureAt = 0

export function installRendererMemoryMonitor(): () => void {
  if (installed) return () => {}
  installed = true

  const initialTimer = window.setTimeout(runRendererMemorySample, RENDERER_MEMORY_INITIAL_DELAY_MS)
  const interval = window.setInterval(runRendererMemorySample, RENDERER_MEMORY_SAMPLE_MS)

  return () => {
    window.clearTimeout(initialTimer)
    window.clearInterval(interval)
    installed = false
  }
}

function runRendererMemorySample(): void {
  void sampleRendererMemory().catch((error) => {
    console.warn('[RendererMemory] sample failed', error)
  })
}

function shouldLogRendererMemory(): boolean {
  if (import.meta.env.DEV) return true
  if (useSettingsStore.getState().devMode) return true
  try {
    return localStorage.getItem('openCowork.rendererMemoryDebug') === '1'
  } catch {
    return false
  }
}

function readChromiumMemory(): ChromiumPerformanceMemory | null {
  const memory = (performance as Performance & { memory?: ChromiumPerformanceMemory }).memory
  return memory ?? null
}

async function sampleRendererMemory(): Promise<void> {
  const chatStore = useChatStore.getState()
  chatStore.releaseDormantSessions()

  const state = useChatStore.getState()
  const agentState = useAgentStore.getState()
  const residentSessions = state.sessions.filter((session) => session.messages.length > 0)
  const residentMessages = residentSessions.reduce(
    (sum, session) => sum + session.messages.length,
    0
  )
  const residentContentChars = residentSessions.reduce(
    (sum, session) => sum + estimateMessagesContentChars(session.messages),
    0
  )
  const previewContentChars = Object.values(state.generatingImagePreviews).reduce(
    (sum, preview) => sum + estimateContentBlockChars(preview),
    0
  )
  const heap = readChromiumMemory()
  const debugStore = getRequestDebugStoreStats()
  const agentStoreChars = estimateAgentStoreChars(agentState)
  const domRows = document.querySelectorAll('[data-message-content] [data-index]').length
  const usedJsHeap = heap?.usedJSHeapSize ?? 0

  if (
    usedJsHeap >= HARD_USED_JS_HEAP_BYTES ||
    residentContentChars >= SOFT_RESIDENT_CONTENT_CHARS * 2
  ) {
    applyMemoryPressure('hard')
  } else if (
    usedJsHeap >= SOFT_USED_JS_HEAP_BYTES ||
    residentContentChars >= SOFT_RESIDENT_CONTENT_CHARS
  ) {
    applyMemoryPressure('soft')
  }

  if (!shouldLogRendererMemory()) return
  const processMemory = await readProcessMemoryDiagnostics()

  const details = {
    heap: heap
      ? {
          usedMB: bytesToMb(heap.usedJSHeapSize),
          totalMB: bytesToMb(heap.totalJSHeapSize),
          limitMB: bytesToMb(heap.jsHeapSizeLimit)
        }
      : null,
    sessions: state.sessions.length,
    residentSessions: residentSessions.length,
    residentMessages,
    knownMessages: state.sessions.reduce((sum, session) => sum + session.messageCount, 0),
    residentContentMB: charsToMb(residentContentChars),
    agentStoreMB: charsToMb(agentStoreChars),
    domRows,
    reducedMemoryMode,
    generatingImagePreviews: Object.keys(state.generatingImagePreviews).length,
    previewContentMB: charsToMb(previewContentChars),
    debugStore: {
      entries: debugStore.entries,
      debugEntries: debugStore.debugEntries,
      bodyMB: charsToMb(debugStore.bodyChars),
      contextWindowMB: charsToMb(debugStore.contextWindowChars)
    },
    processes: processMemory
      ? {
          sampledAt: processMemory.sampledAt,
          main: {
            pid: processMemory.main.pid,
            rssMB: bytesToMb(processMemory.main.memory.rss),
            heapUsedMB: bytesToMb(processMemory.main.memory.heapUsed)
          },
          nativeWorker: processMemory.nativeWorker
            ? {
                pid: processMemory.nativeWorker.pid ?? null,
                success: processMemory.nativeWorker.success ?? null,
                workingSetMB: bytesToMb(processMemory.nativeWorker.workingSetBytes),
                managedMB: bytesToMb(processMemory.nativeWorker.managedBytes),
                heapMB: bytesToMb(processMemory.nativeWorker.heapBytes),
                error: processMemory.nativeWorker.error ?? null
              }
            : null,
          appMetrics: processMemory.appMetrics.map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            workingSetMB: metric.memory?.workingSetKb
              ? bytesToMb(metric.memory.workingSetKb * 1024)
              : null,
            privateMB: metric.memory?.privateKb ? bytesToMb(metric.memory.privateKb * 1024) : null
          }))
        }
      : null,
    activeSessionId: state.activeSessionId
  }
  const shouldWarn =
    usedJsHeap >= WARN_USED_JS_HEAP_BYTES ||
    residentContentChars >= WARN_RESIDENT_CONTENT_CHARS ||
    agentStoreChars >= WARN_RESIDENT_CONTENT_CHARS ||
    previewContentChars >= WARN_RESIDENT_CONTENT_CHARS
  const log = shouldWarn ? console.warn : console.log
  log('[RendererMemory] sample', details)
}

async function readProcessMemoryDiagnostics(): Promise<ProcessMemoryDiagnostics | null> {
  try {
    return await invokeMessagePackBinary<ProcessMemoryDiagnostics>(
      DIAGNOSTICS_MEMORY_SAMPLE_MSGPACK_CHANNEL,
      {}
    )
  } catch (error) {
    console.warn('[RendererMemory] process memory sample failed', error)
    return null
  }
}

function applyMemoryPressure(mode: 'soft' | 'hard'): void {
  const now = Date.now()
  if (now - lastMemoryPressureAt < MEMORY_PRESSURE_COOLDOWN_MS && mode !== 'hard') return
  lastMemoryPressureAt = now

  const chatStore = useChatStore.getState()
  chatStore.trimResidentMessageWindows()
  compactRequestDebugStore(mode === 'hard' ? 512 : 2_000)
  useAgentStore.getState().compactMemoryFootprint()

  if (mode !== 'hard' || reducedMemoryMode) return
  reducedMemoryMode = true
  document.documentElement.dataset.reducedMemory = 'true'
  try {
    localStorage.setItem('openCowork.reducedMemoryMode', '1')
  } catch {
    // Ignore storage failures; the in-memory flag is enough for this run.
  }
  toast.warning('Reduced-memory mode enabled for this window')
}

function estimateMessagesContentChars(messages: UnifiedMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateMessageContentChars(message)
    total += message.debugInfo?.body?.length ?? 0
    total += message.debugInfo?.contextWindowBody?.length ?? 0
  }
  return total
}

function estimateMessageContentChars(message: UnifiedMessage): number {
  if (typeof message.content === 'string') return message.content.length
  if (!Array.isArray(message.content)) return 0
  return message.content.reduce((sum, block) => sum + estimateContentBlockChars(block), 0)
}

function estimateContentBlockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length
    case 'thinking':
      return block.thinking.length + (block.encryptedContent?.length ?? 0)
    case 'image':
      return block.source.type === 'base64'
        ? (block.source.data?.length ?? 0)
        : (block.source.url?.length ?? 0)
    case 'tool_use':
      return block.name.length + estimateJsonChars(block.input)
    case 'tool_result':
      return estimateJsonChars(block.content)
    case 'image_error':
      return block.message.length
    case 'agent_error':
      return block.message.length
    default:
      return estimateJsonChars(block)
  }
}

function estimateJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function estimateAgentStoreChars(state: ReturnType<typeof useAgentStore.getState>): number {
  return (
    estimateJsonChars(state.pendingToolCalls) +
    estimateJsonChars(state.executedToolCalls) +
    estimateJsonChars(state.activeSubAgents) +
    estimateJsonChars(state.completedSubAgents) +
    estimateJsonChars(state.subAgentHistory) +
    estimateJsonChars(state.sessionToolCallsCache) +
    estimateJsonChars(state.sessionSubAgentLiveCache) +
    estimateJsonChars(state.backgroundProcesses)
  )
}

function bytesToMb(value?: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round((value / 1024 / 1024) * 10) / 10
}

function charsToMb(chars: number): number {
  return Math.round((chars / 1024 / 1024) * 10) / 10
}
