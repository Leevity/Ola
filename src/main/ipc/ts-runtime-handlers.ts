import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { lstat } from 'node:fs/promises'
import { basename, extname, isAbsolute, posix, win32 } from 'node:path'
import { desktopRuntime } from '../runtime/desktop-runtime'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  RUNTIME_CAPABILITIES,
  parseRunSpec,
  type RunSnapshot,
  type RunSummary
} from '../../shared/runtime/contracts'
import {
  beginMainSshWorkspaceSwitch,
  hasActiveMainSshWorkspaceActivity,
  statSshRuntimePath
} from './ssh-handlers'
import { beginCronWorkspaceSwitch, hasActiveOrFinishingCronRuns } from '../cron/cron-scheduler'
import { beginDesktopFlowWorkspaceSwitch } from './desktop-flow-handlers'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { hasActiveLocalTerminalSessions } from './terminal-handlers'
import { getSession } from '../db/sessions-dao'
import { getTask } from '../db/tasks-dao'
import { getProject } from '../db/projects-dao'
import { TsRuntimeWorkspaceAdmission } from '../runtime/ts-runtime-workspace-admission'
import { listCronRuns } from '../db/cron-dao'
import {
  executionRecordFromCronRun,
  executionRecordFromTsRun,
  type ExecutionPageKey,
  type ExecutionRecordCursor,
  type ExecutionSourceCursor
} from '../../shared/execution-record'
import type { ExecutionArtifact } from '../../shared/execution-artifact'
import {
  cleanupRuntimeImageAssets,
  stageRuntimeImageAsset
} from '../../runtime/storage/runtime-image-assets'
const ARTIFACT_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.pjp': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/vnd.microsoft.icon',
  '.cur': 'image/vnd.microsoft.icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jxl': 'image/jxl',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t'
}
const ARTIFACT_DATA_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.xml',
  '.yaml',
  '.yml',
  '.parquet',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.ods'
])
const ARTIFACT_DOCUMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.doc',
  '.docx',
  '.docm',
  '.dotx',
  '.dotm',
  '.pdf',
  '.rtf',
  '.odt',
  '.ppt',
  '.pptx',
  '.pptm',
  '.odp'
])

function executionArtifactCategory(extension: string, mediaType?: string): string {
  if (mediaType?.startsWith('image/')) return 'image'
  if (mediaType?.startsWith('audio/') || mediaType?.startsWith('video/')) return 'media'
  if (ARTIFACT_DATA_EXTENSIONS.has(extension)) return 'data'
  if (ARTIFACT_DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  return 'other'
}
import {
  parseRuntimeInteractionRequest,
  parseRuntimeRunLocator,
  parseRuntimeRunSnapshotLocator,
  parseRuntimeWorkspaceRequest,
  parseRuntimeWorkspaceSwitchRequest
} from './ts-runtime-requests'

function trusted(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return (
    window !== null &&
    !window.isDestroyed() &&
    window.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

function assertWindowWorkspace(event: IpcMainInvokeEvent, workspaceId: string): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || getRegisteredWindowWorkspace(window) !== workspaceId)
    throw new Error('WINDOW_WORKSPACE_MISMATCH')
}

function parseExecutionPageKey(value: unknown): ExecutionPageKey | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_REQUEST')
  const key = value as Record<string, unknown>
  if (
    Object.keys(key).some((field) => field !== 'at' && field !== 'id') ||
    typeof key.at !== 'number' ||
    !Number.isSafeInteger(key.at) ||
    key.at < 0 ||
    typeof key.id !== 'string' ||
    !key.id.trim() ||
    key.id.length > 256
  )
    throw new Error('INVALID_REQUEST')
  return { at: key.at, id: key.id }
}

function parseExecutionSourceCursor(value: unknown): ExecutionSourceCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_REQUEST')
  const source = value as Record<string, unknown>
  if (
    Object.keys(source).some((field) => field !== 'anchor' && field !== 'after') ||
    !Object.hasOwn(source, 'anchor') ||
    !Object.hasOwn(source, 'after')
  )
    throw new Error('INVALID_REQUEST')
  const anchor = parseExecutionPageKey(source.anchor)
  const after = parseExecutionPageKey(source.after)
  if (anchor === null && after !== null) throw new Error('INVALID_REQUEST')
  return { anchor, after }
}

function parseExecutionCursor(value: unknown): ExecutionRecordCursor | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_REQUEST')
  const cursor = value as Record<string, unknown>
  if (
    Object.keys(cursor).some((field) => field !== 'ts' && field !== 'cron') ||
    !Object.hasOwn(cursor, 'ts') ||
    !Object.hasOwn(cursor, 'cron')
  )
    throw new Error('INVALID_REQUEST')
  return {
    ts: parseExecutionSourceCursor(cursor.ts),
    cron: parseExecutionSourceCursor(cursor.cron)
  }
}

function workspaceSwitchBusyReason(workspaceId?: string): string | null {
  if (hasActiveOrFinishingCronRuns()) return 'WORKSPACE_BUSY_CRON'
  if (hasActiveMainSshWorkspaceActivity()) return 'WORKSPACE_BUSY_SSH'
  const workspaces = workspaceId
    ? [workspaceId]
    : BrowserWindow.getAllWindows()
        .map((win) => getRegisteredWindowWorkspace(win))
        .filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of new Set(workspaces)) {
    if (hasActiveLocalTerminalSessions(candidate)) return 'WORKSPACE_BUSY_TERMINAL'
  }
  return null
}

interface SessionRuntimeGate {
  deleting: boolean
  submissions: number
  changed: Set<() => void>
}

const sessionRuntimeGates = new Map<string, SessionRuntimeGate>()

function sessionRuntimeGateKey(
  workspaceId: string,
  scope: 'session' | 'project',
  id: string
): string {
  return JSON.stringify([workspaceId, scope, id])
}

function getSessionRuntimeGate(
  workspaceId: string,
  scope: 'session' | 'project',
  id: string
): SessionRuntimeGate {
  const key = sessionRuntimeGateKey(workspaceId, scope, id)
  let gate = sessionRuntimeGates.get(key)
  if (!gate) {
    gate = { deleting: false, submissions: 0, changed: new Set() }
    sessionRuntimeGates.set(key, gate)
  }
  return gate
}

function cleanupSessionRuntimeGate(
  workspaceId: string,
  scope: 'session' | 'project',
  id: string,
  gate: SessionRuntimeGate
): void {
  if (!gate.deleting && gate.submissions === 0 && gate.changed.size === 0) {
    sessionRuntimeGates.delete(sessionRuntimeGateKey(workspaceId, scope, id))
  }
}

export function beginRuntimeSessionSubmission(
  workspaceId: string,
  sessionId: string,
  projectId?: string
): () => void {
  const gates = [getSessionRuntimeGate(workspaceId, 'session', sessionId)]
  if (projectId) gates.push(getSessionRuntimeGate(workspaceId, 'project', projectId))
  if (gates.some((gate) => gate.deleting)) throw new Error('SESSION_DELETE_IN_PROGRESS')
  for (const gate of gates) gate.submissions += 1
  let released = false
  return () => {
    if (released) return
    released = true
    for (const gate of gates) {
      gate.submissions = Math.max(0, gate.submissions - 1)
      for (const resolve of [...gate.changed]) resolve()
    }
    cleanupSessionRuntimeGate(workspaceId, 'session', sessionId, gates[0])
    if (projectId) cleanupSessionRuntimeGate(workspaceId, 'project', projectId, gates[1])
  }
}

async function acquireRuntimeGateDeletion(
  workspaceId: string,
  scope: 'session' | 'project',
  id: string
): Promise<() => void> {
  const gate = getSessionRuntimeGate(workspaceId, scope, id)
  if (gate.deleting) throw new Error('SESSION_DELETE_IN_PROGRESS')
  gate.deleting = true
  try {
    while (gate.submissions > 0) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          gate.changed.delete(wake)
          resolve()
        }
        gate.changed.add(wake)
      })
    }
    if (scope === 'session' && desktopRuntime.isAvailable) {
      const sessionId = id
      await desktopRuntime.request('run.cancel-session', { workspaceId, sessionId })
    }
  } catch (error) {
    gate.deleting = false
    cleanupSessionRuntimeGate(workspaceId, scope, id, gate)
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    gate.deleting = false
    cleanupSessionRuntimeGate(workspaceId, scope, id, gate)
  }
}

export function acquireRuntimeSessionDeletion(
  workspaceId: string,
  sessionId: string
): Promise<() => void> {
  return acquireRuntimeGateDeletion(workspaceId, 'session', sessionId)
}

export function acquireRuntimeProjectDeletion(
  workspaceId: string,
  projectId: string
): Promise<() => void> {
  return acquireRuntimeGateDeletion(workspaceId, 'project', projectId)
}

export function registerTsRuntimeHandlers(): void {
  const admission = new TsRuntimeWorkspaceAdmission()
  registerMessagePackHandler<void>('worker:memory', (_args, event) => {
    if (!trusted(event)) return { memory: null, error: 'UNAUTHORIZED_IPC_SENDER' }
    return { memory: process.memoryUsage(), runtime: 'typescript' }
  })
  registerMessagePackHandler<void>('worker:routes', (_args, event) => {
    if (!trusted(event)) return { routes: [], error: 'UNAUTHORIZED_IPC_SENDER' }
    return {
      routes: [
        'run.submit',
        'run.snapshot',
        'run.list',
        'run.cancel',
        'run.cancel-session',
        'run.interact',
        'workspace.switch'
      ],
      capabilities: [...RUNTIME_CAPABILITIES],
      runtime: 'typescript'
    }
  })
  registerMessagePackHandler<void>('ts-runtime:status', (_args, event) => {
    if (!trusted(event)) return { available: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    return { available: desktopRuntime.isAvailable }
  })
  registerMessagePackHandler<unknown>('ts-runtime:workspace-activity', (args, event) => {
    if (!trusted(event)) return { busy: true, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId } = parseRuntimeWorkspaceRequest(args)
      assertWindowWorkspace(event, workspaceId)
      if (admission.hasPendingSubmission || admission.isSwitching)
        return { busy: true, reason: 'WORKSPACE_BUSY_TS_RUNTIME' }
      const reason = workspaceSwitchBusyReason(workspaceId)
      return reason ? { busy: true, reason } : { busy: false }
    } catch (error) {
      return {
        busy: true,
        error: error instanceof Error ? error.message : 'WORKSPACE_ACTIVITY_UNAVAILABLE'
      }
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:workspace-switch', async (args, event) => {
    if (!trusted(event)) return { switched: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    let releaseTsAdmission: (() => void) | undefined
    let releaseCronAdmission: (() => void) | undefined
    let releaseDesktopFlowAdmission: (() => void) | undefined
    let releaseSshAdmission: (() => void) | undefined
    try {
      const { fromWorkspaceId, workspaceId } = parseRuntimeWorkspaceSwitchRequest(args)
      assertWindowWorkspace(event, fromWorkspaceId)
      releaseTsAdmission = admission.beginSwitch()
      releaseCronAdmission = beginCronWorkspaceSwitch()
      releaseDesktopFlowAdmission = beginDesktopFlowWorkspaceSwitch()
      releaseSshAdmission = beginMainSshWorkspaceSwitch()
      const busyReason = workspaceSwitchBusyReason(fromWorkspaceId)
      if (busyReason) return { switched: false, error: busyReason }
      await desktopRuntime.request('workspace.switch', { workspaceId })
      assertWindowWorkspace(event, fromWorkspaceId)
      return { switched: true }
    } catch (error) {
      return {
        switched: false,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    } finally {
      releaseSshAdmission?.()
      releaseDesktopFlowAdmission?.()
      releaseCronAdmission?.()
      releaseTsAdmission?.()
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:runs-list', async (args, event) => {
    if (!trusted(event)) return { runs: [], error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId } = parseRuntimeWorkspaceRequest(args)
      assertWindowWorkspace(event, workspaceId)
      const runs = await desktopRuntime.request('run.list', { workspaceId })
      assertWindowWorkspace(event, workspaceId)
      return { runs }
    } catch (error) {
      return { runs: [], error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE' }
    }
  })
  registerMessagePackHandler<unknown>('execution-records:list', async (args, event) => {
    if (!trusted(event)) return { records: [], nextCursor: null, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const input = args as Record<string, unknown>
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('INVALID_REQUEST')
      if (Object.keys(input).some((key) => !['workspaceId', 'cursor', 'filter'].includes(key)))
        throw new Error('INVALID_REQUEST')
      const { workspaceId } = parseRuntimeWorkspaceRequest({ workspaceId: input.workspaceId })
      const filter = input.filter ?? 'all'
      if (filter !== 'all' && filter !== 'attention') throw new Error('INVALID_REQUEST')
      const cursor = parseExecutionCursor(input.cursor)
      const pageSize = 50
      assertWindowWorkspace(event, workspaceId)
      const [runs, cronRuns] = await Promise.all([
        cursor?.ts.anchor === null
          ? Promise.resolve([] as RunSummary[])
          : desktopRuntime.request<RunSummary[]>('run.list', {
              workspaceId,
              limit: pageSize + 1,
              attentionOnly: filter === 'attention',
              ...(cursor?.ts.anchor ? { anchor: cursor.ts.anchor } : {}),
              ...(cursor?.ts.after ? { after: cursor.ts.after } : {})
            }),
        cursor?.cron.anchor === null
          ? Promise.resolve([])
          : listCronRuns({
              workspaceId,
              limit: pageSize + 1,
              attentionOnly: filter === 'attention',
              ...(cursor?.cron.anchor ? { anchor: cursor.cron.anchor } : {}),
              ...(cursor?.cron.after ? { after: cursor.cron.after } : {})
            })
      ])
      assertWindowWorkspace(event, workspaceId)
      const scopedRuns = (Array.isArray(runs) ? runs : []).filter(
        (run) => run.workspaceId === workspaceId
      )
      const candidates = [
        ...scopedRuns.map((run, sourceIndex) => ({
          source: 'ts' as const,
          sourceIndex,
          run,
          startedAt: run.createdAt
        })),
        ...cronRuns.map((run, sourceIndex) => ({
          source: 'cron' as const,
          sourceIndex,
          run,
          startedAt: run.started_at
        }))
      ].sort(
        (left, right) =>
          right.startedAt - left.startedAt ||
          left.source.localeCompare(right.source) ||
          left.sourceIndex - right.sourceIndex
      )
      const selected = candidates.slice(0, pageSize)
      const consumedTs = selected.filter((item) => item.source === 'ts').length
      const consumedCron = selected.length - consumedTs
      const lastTs = [...selected].reverse().find((item) => item.source === 'ts')
      const lastCron = [...selected].reverse().find((item) => item.source === 'cron')
      const nextCursor =
        scopedRuns.length > consumedTs || cronRuns.length > consumedCron
          ? {
              ts: {
                anchor:
                  cursor?.ts.anchor ??
                  (scopedRuns[0] ? { at: scopedRuns[0].createdAt, id: scopedRuns[0].runId } : null),
                after: lastTs
                  ? { at: lastTs.startedAt, id: lastTs.run.runId }
                  : (cursor?.ts.after ?? null)
              },
              cron: {
                anchor:
                  cursor?.cron.anchor ??
                  (cronRuns[0] ? { at: cronRuns[0].started_at, id: cronRuns[0].id } : null),
                after: lastCron
                  ? { at: lastCron.startedAt, id: lastCron.run.id }
                  : (cursor?.cron.after ?? null)
              }
            }
          : null
      const tsRecords = await Promise.all(
        selected
          .filter((item) => item.source === 'ts')
          .map((item) => item.run)
          .map(async (run) => {
            const [session, businessTask] = await Promise.all([
              getSession(run.sessionId, workspaceId).catch(() => undefined),
              run.businessTaskId
                ? getTask(run.businessTaskId, workspaceId).catch(() => undefined)
                : Promise.resolve(undefined)
            ])
            const linkedTask = businessTask?.session_id === run.sessionId ? businessTask : undefined
            try {
              const snapshot = await desktopRuntime.request<RunSnapshot>('run.snapshot', {
                workspaceId,
                runId: run.runId
              })
              return {
                ...executionRecordFromTsRun(
                  run,
                  snapshot?.events ?? [],
                  snapshot?.pendingInteractions ?? []
                ),
                title:
                  run.businessTaskTitle?.trim() ||
                  linkedTask?.subject?.trim() ||
                  session?.title?.trim() ||
                  run.taskId,
                projectId: run.projectId ?? session?.project_id ?? null
              }
            } catch {
              // A run may finish between list and snapshot. Keep its durable summary visible.
              return {
                ...executionRecordFromTsRun(run),
                title:
                  run.businessTaskTitle?.trim() ||
                  linkedTask?.subject?.trim() ||
                  session?.title?.trim() ||
                  run.taskId,
                projectId: run.projectId ?? session?.project_id ?? null
              }
            }
          })
      )
      assertWindowWorkspace(event, workspaceId)
      const selectedOrder = new Map(
        selected.map((item, index) => [
          `${item.source}:${item.source === 'ts' ? item.run.runId : item.run.id}`,
          index
        ])
      )
      const records = [
        ...tsRecords,
        ...selected
          .filter((item) => item.source === 'cron')
          .map((item) => item.run)
          .map((run) =>
            executionRecordFromCronRun({
              id: run.id,
              jobId: run.job_id,
              workspaceId,
              startedAt: run.started_at,
              finishedAt: run.finished_at,
              status: run.status,
              jobName: run.job_name_snapshot,
              sessionId: run.source_session_id_snapshot,
              projectId: run.source_project_id_snapshot,
              toolCallCount: run.tool_call_count,
              error: run.error,
              deliveryMode: run.delivery_mode_snapshot,
              deliveryTarget: run.delivery_target_snapshot,
              deliveryStatus: run.delivery_status
            })
          )
      ].sort(
        (left, right) =>
          (selectedOrder.get(`${left.source === 'cron' ? 'cron' : 'ts'}:${left.id}`) ?? 0) -
          (selectedOrder.get(`${right.source === 'cron' ? 'cron' : 'ts'}:${right.id}`) ?? 0)
      )
      return { records, nextCursor }
    } catch (error) {
      return {
        records: [],
        nextCursor: null,
        error: error instanceof Error ? error.message : 'EXECUTION_RECORDS_UNAVAILABLE'
      }
    }
  })
  registerMessagePackHandler<unknown>('execution-artifacts:list', async (args, event) => {
    if (!trusted(event))
      return { artifacts: [], nextOffset: null, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('INVALID_ARTIFACT_QUERY')
      const input = args as Record<string, unknown>
      if (
        Object.keys(input).some(
          (key) =>
            ![
              'workspaceId',
              'offset',
              'limit',
              'projectId',
              'query',
              'runId',
              'category',
              'createdAfter'
            ].includes(key)
        )
      )
        throw new Error('INVALID_ARTIFACT_QUERY')
      const { workspaceId } = parseRuntimeWorkspaceRequest({ workspaceId: input.workspaceId })
      assertWindowWorkspace(event, workspaceId)
      const offset = input.offset ?? 0
      const limit = input.limit ?? 50
      const projectId = input.projectId
      const query = input.query
      const runId = input.runId
      const category = input.category ?? 'all'
      const createdAfter = input.createdAfter
      if (
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof limit !== 'number' ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (projectId !== undefined &&
          (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 256)) ||
        (query !== undefined && (typeof query !== 'string' || query.length > 200)) ||
        (runId !== undefined &&
          (typeof runId !== 'string' || !runId.trim() || runId.length > 256)) ||
        !['all', 'link', 'image', 'media', 'document', 'data', 'other'].includes(
          String(category)
        ) ||
        (createdAfter !== undefined &&
          (typeof createdAfter !== 'number' ||
            !Number.isSafeInteger(createdAfter) ||
            createdAfter < 0))
      )
        throw new Error('INVALID_ARTIFACT_QUERY')
      if (projectId && !(await getProject(projectId, workspaceId)))
        throw new Error('PROJECT_WORKSPACE_MISMATCH')
      const records: ExecutionArtifact[] = []
      let cursor = offset
      let exhausted = false
      let scanned = 0
      const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : ''
      while (records.length < limit && scanned < 500 && !exhausted) {
        const rows = await desktopRuntime.request<
          Array<{
            runId: string
            seq: number
            data: unknown
            timestamp: number
            sessionId: string
            status: ExecutionArtifact['runStatus']
            projectId: string | null
          }>
        >('artifact.list', { workspaceId, offset: cursor, limit: 100, runId })
        assertWindowWorkspace(event, workspaceId)
        if (!Array.isArray(rows)) throw new Error('ARTIFACT_LIST_UNAVAILABLE')
        let consumed = 0
        for (const row of rows) {
          cursor++
          scanned++
          consumed++
          if (createdAfter !== undefined && row.timestamp < createdAfter) continue
          if (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)) continue
          const data = row.data as Record<string, unknown>
          if (
            (data.kind !== 'file' && data.kind !== 'link') ||
            typeof data.toolCallId !== 'string' ||
            !data.toolCallId
          )
            continue
          const session = await getSession(row.sessionId, workspaceId).catch(() => undefined)
          const recordProjectId = row.projectId ?? session?.project_id ?? null
          if (projectId && recordProjectId !== projectId) continue
          if (data.kind === 'link') {
            if (typeof data.url !== 'string' || data.url.length > 4096) continue
            let url: URL
            try {
              url = new URL(data.url)
            } catch {
              continue
            }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
              continue
            const title =
              typeof data.title === 'string' && data.title.trim()
                ? data.title.trim().slice(0, 256)
                : url.hostname
            if (category !== 'all' && category !== 'link') continue
            if (
              normalizedQuery &&
              !title.toLowerCase().includes(normalizedQuery) &&
              !url.toString().toLowerCase().includes(normalizedQuery)
            )
              continue
            records.push({
              id: `${row.runId}:${row.seq}`,
              workspaceId,
              projectId: recordProjectId,
              sessionId: row.sessionId,
              runId: row.runId,
              seq: row.seq,
              toolCallId: data.toolCallId,
              kind: 'link',
              url: url.toString(),
              title,
              createdAt: row.timestamp,
              runStatus: row.status
            })
            if (records.length >= limit) break
            continue
          }
          if (
            data.transport !== undefined &&
            data.transport !== 'local' &&
            data.transport !== 'ssh'
          )
            continue
          const transport = data.transport === 'ssh' ? 'ssh' : 'local'
          const connectionId = data.connectionId
          if (
            typeof data.path !== 'string' ||
            data.path.length > 4096 ||
            (transport === 'local' && !isAbsolute(data.path)) ||
            (transport === 'ssh' && !posix.isAbsolute(data.path) && !win32.isAbsolute(data.path)) ||
            (transport === 'ssh' &&
              (typeof connectionId !== 'string' ||
                !connectionId.trim() ||
                connectionId.length > 256 ||
                session?.ssh_connection_id !== connectionId))
          )
            continue
          const title = basename(data.path)
          const extension = extname(data.path).toLowerCase()
          const mediaType = ARTIFACT_MEDIA_TYPES[extension]
          const artifactCategory = executionArtifactCategory(extension, mediaType)
          if (category !== 'all' && category !== artifactCategory) continue
          if (
            normalizedQuery &&
            !title.toLowerCase().includes(normalizedQuery) &&
            !data.path.toLowerCase().includes(normalizedQuery)
          )
            continue
          let exists: boolean
          if (transport === 'ssh') {
            const stat = (await statSshRuntimePath(
              workspaceId,
              connectionId as string,
              data.path
            ).catch(() => null)) as { exists?: boolean; type?: string | null } | null
            exists = stat?.exists === true && stat.type === 'file'
          } else {
            const stat = await lstat(data.path).catch(() => null)
            exists = stat?.isFile() === true
          }
          records.push({
            id: `${row.runId}:${row.seq}`,
            workspaceId,
            projectId: recordProjectId,
            sessionId: row.sessionId,
            runId: row.runId,
            seq: row.seq,
            toolCallId: data.toolCallId,
            kind: 'file',
            transport,
            ...(transport === 'ssh' ? { connectionId: connectionId as string } : {}),
            ...(mediaType || data.mediaType === 'image/png'
              ? {
                  mediaType: typeof data.mediaType === 'string' ? data.mediaType : mediaType
                }
              : {}),
            path: data.path,
            title,
            operation: data.operation === 'create' ? 'create' : 'modify',
            createdAt: row.timestamp,
            runStatus: row.status,
            exists
          })
          if (records.length >= limit) break
        }
        exhausted = rows.length < 100 && consumed === rows.length
      }
      assertWindowWorkspace(event, workspaceId)
      return { artifacts: records, nextOffset: exhausted ? null : cursor }
    } catch (error) {
      return {
        artifacts: [],
        nextOffset: null,
        error: error instanceof Error ? error.message : 'ARTIFACT_LIST_UNAVAILABLE'
      }
    }
  })
  registerMessagePackHandler<unknown>('execution-artifacts:hide', async (args, event) => {
    if (!trusted(event)) return { hidden: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('INVALID_ARTIFACT_ID')
      const input = args as Record<string, unknown>
      if (
        Object.keys(input).some((key) => !['workspaceId', 'runId', 'seq'].includes(key)) ||
        typeof input.runId !== 'string' ||
        !input.runId.trim() ||
        input.runId.length > 256 ||
        typeof input.seq !== 'number' ||
        !Number.isSafeInteger(input.seq) ||
        input.seq < 1
      )
        throw new Error('INVALID_ARTIFACT_ID')
      const { workspaceId } = parseRuntimeWorkspaceRequest({ workspaceId: input.workspaceId })
      assertWindowWorkspace(event, workspaceId)
      const result = await desktopRuntime.request<{ hidden: boolean }>('artifact.hide', {
        workspaceId,
        runId: input.runId,
        seq: input.seq
      })
      assertWindowWorkspace(event, workspaceId)
      return result
    } catch (error) {
      return {
        hidden: false,
        error: error instanceof Error ? error.message : 'ARTIFACT_HIDE_FAILED'
      }
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:run-submit', async (args, event) => {
    if (!trusted(event)) return { accepted: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    let releaseSubmission: (() => void) | undefined
    let releaseSessionSubmission: (() => void) | undefined
    try {
      const run = parseRunSpec(args)
      assertWindowWorkspace(event, run.workspaceId)
      releaseSubmission = admission.beginSubmission()
      const owningSession = await getSession(run.sessionId, run.workspaceId)
      if (!owningSession) throw new Error('SESSION_WORKSPACE_MISMATCH')
      if (owningSession.project_id) run.projectId = owningSession.project_id
      else delete run.projectId
      releaseSessionSubmission = beginRuntimeSessionSubmission(
        run.workspaceId,
        run.sessionId,
        owningSession.project_id ?? undefined
      )
      if (run.businessTaskId) {
        const task = await getTask(run.businessTaskId, run.workspaceId)
        if (!task || task.session_id !== run.sessionId)
          throw new Error('TASK_SESSION_WORKSPACE_MISMATCH')
        run.businessTaskTitle = task.subject.trim().slice(0, 512) || run.businessTaskId
      }
      assertWindowWorkspace(event, run.workspaceId)
      const submitted = await desktopRuntime.request('run.submit', run)
      try {
        assertWindowWorkspace(event, run.workspaceId)
      } catch (error) {
        await desktopRuntime
          .request('run.cancel', {
            workspaceId: run.workspaceId,
            runId: run.runId
          })
          .catch((cancelError) => {
            console.warn('[TS Runtime] Failed to cancel a stale window submission', cancelError)
          })
        throw error
      }
      return { accepted: true, run: submitted }
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    } finally {
      releaseSubmission?.()
      releaseSessionSubmission?.()
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:asset-stage', async (args, event) => {
    if (!trusted(event)) return { staged: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('INVALID_RUNTIME_ASSET')
      const value = args as Record<string, unknown>
      if (
        typeof value.workspaceId !== 'string' ||
        typeof value.mimeType !== 'string' ||
        typeof value.base64 !== 'string'
      )
        throw new Error('INVALID_RUNTIME_ASSET')
      assertWindowWorkspace(event, value.workspaceId)
      await cleanupRuntimeImageAssets(value.workspaceId)
      const staged = await stageRuntimeImageAsset({
        workspaceId: value.workspaceId,
        mimeType: value.mimeType,
        base64: value.base64
      })
      return { staged: true, ...staged }
    } catch (error) {
      return {
        staged: false,
        error: error instanceof Error ? error.message : 'RUNTIME_ASSET_FAILED'
      }
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:run-snapshot', async (args, event) => {
    if (!trusted(event)) return { snapshot: null, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId, runId, afterSeq } = parseRuntimeRunSnapshotLocator(args)
      assertWindowWorkspace(event, workspaceId)
      const snapshot = await desktopRuntime.request('run.snapshot', {
        workspaceId,
        runId,
        afterSeq
      })
      assertWindowWorkspace(event, workspaceId)
      return {
        snapshot
      }
    } catch (error) {
      return {
        snapshot: null,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:run-cancel', async (args, event) => {
    if (!trusted(event)) return { cancelled: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId, runId } = parseRuntimeRunLocator(args)
      assertWindowWorkspace(event, workspaceId)
      await desktopRuntime.request('run.cancel', { workspaceId, runId })
      return { cancelled: true }
    } catch (error) {
      return {
        cancelled: false,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    }
  })

  // These aliases preserve the old Agent IPC contract while routing every
  // cancellation decision through the TS scheduler. They are intentionally
  // thin: no second run registry or reverse-request transport is allowed.
  const cancelAgentRun = async (args: unknown, event: IpcMainInvokeEvent) => {
    if (!trusted(event)) return { cancelled: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId, runId } = parseRuntimeRunLocator(args)
      assertWindowWorkspace(event, workspaceId)
      await desktopRuntime.request('run.cancel', { workspaceId, runId })
      return { cancelled: true, runId }
    } catch (error) {
      return {
        cancelled: false,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    }
  }
  registerMessagePackHandler<unknown>('agent:request-stop', cancelAgentRun)
  registerMessagePackHandler<unknown>('agent:reverse-cancel', cancelAgentRun)

  registerMessagePackHandler<unknown>('ts-runtime:run-interact', async (args, event) => {
    if (!trusted(event)) return { accepted: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId, runId, interactionId, response } = parseRuntimeInteractionRequest(args)
      assertWindowWorkspace(event, workspaceId)
      await desktopRuntime.request('run.interact', { workspaceId, runId, interactionId, response })
      return { accepted: true }
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    }
  })

  registerMessagePackHandler<unknown>('agent:reverse-response', async (args, event) => {
    if (!trusted(event)) return { accepted: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId, runId, interactionId, response } = parseRuntimeInteractionRequest(args)
      assertWindowWorkspace(event, workspaceId)
      await desktopRuntime.request('run.interact', { workspaceId, runId, interactionId, response })
      return { accepted: true }
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE'
      }
    }
  })
}
