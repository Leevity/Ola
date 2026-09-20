import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { desktopRuntime } from '../runtime/desktop-runtime'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  RUNTIME_CAPABILITIES,
  parseRunSpec,
  type RunSnapshot,
  type RunSummary
} from '../../shared/runtime/contracts'
import { beginMainSshWorkspaceSwitch, hasActiveMainSshWorkspaceActivity } from './ssh-handlers'
import { beginCronWorkspaceSwitch, hasActiveOrFinishingCronRuns } from '../cron/cron-scheduler'
import { beginDesktopFlowWorkspaceSwitch } from './desktop-flow-handlers'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { hasActiveLocalTerminalSessions } from './terminal-handlers'
import { getSession } from '../db/sessions-dao'
import { TsRuntimeWorkspaceAdmission } from '../runtime/ts-runtime-workspace-admission'
import { listCronRuns } from '../db/cron-dao'
import { executionRecordFromCronRun, executionRecordFromTsRun } from '../../shared/execution-record'
import {
  cleanupRuntimeImageAssets,
  stageRuntimeImageAsset
} from '../../runtime/storage/runtime-image-assets'
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
    if (!trusted(event)) return { records: [], error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const { workspaceId } = parseRuntimeWorkspaceRequest(args)
      assertWindowWorkspace(event, workspaceId)
      const [runs, cronRuns] = await Promise.all([
        desktopRuntime.request<RunSummary[]>('run.list', { workspaceId }),
        listCronRuns({ workspaceId, limit: 200 })
      ])
      assertWindowWorkspace(event, workspaceId)
      const tsRecords = await Promise.all(
        (Array.isArray(runs) ? runs : []).slice(0, 200).map(async (run) => {
          const session = await getSession(run.sessionId, workspaceId).catch(() => undefined)
          try {
            const snapshot = await desktopRuntime.request<RunSnapshot>('run.snapshot', {
              workspaceId,
              runId: run.runId
            })
            return {
              ...executionRecordFromTsRun(run, snapshot?.events ?? []),
              projectId: session?.project_id ?? null
            }
          } catch {
            // A run may finish between list and snapshot. Keep its durable summary visible.
            return {
              ...executionRecordFromTsRun(run),
              projectId: session?.project_id ?? null
            }
          }
        })
      )
      assertWindowWorkspace(event, workspaceId)
      const records = [
        ...tsRecords,
        ...cronRuns.map((run) =>
          executionRecordFromCronRun({
            id: run.id,
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
            deliveryTarget: run.delivery_target_snapshot
          })
        )
      ].sort((left, right) => right.startedAt - left.startedAt)
      return { records: records.slice(0, 200) }
    } catch (error) {
      return {
        records: [],
        error: error instanceof Error ? error.message : 'EXECUTION_RECORDS_UNAVAILABLE'
      }
    }
  })
  registerMessagePackHandler<unknown>('ts-runtime:run-submit', async (args, event) => {
    if (!trusted(event)) return { accepted: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    let releaseSubmission: (() => void) | undefined
    try {
      const run = parseRunSpec(args)
      assertWindowWorkspace(event, run.workspaceId)
      releaseSubmission = admission.beginSubmission()
      if (!(await getSession(run.sessionId, run.workspaceId)))
        throw new Error('SESSION_WORKSPACE_MISMATCH')
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
