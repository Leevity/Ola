import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { desktopRuntime } from '../runtime/desktop-runtime'
import { registerMessagePackHandler } from './messagepack-handler'
import { parseRunSpec } from '../../shared/runtime/contracts'
import { beginMainSshWorkspaceSwitch, hasActiveMainSshWorkspaceActivity } from './ssh-handlers'
import { getNativeAgentRuntimeManager } from './native-agent-runtime'
import { beginCronWorkspaceSwitch, hasActiveOrFinishingCronRuns } from '../cron/cron-scheduler'
import { beginDesktopFlowWorkspaceSwitch } from './desktop-flow-handlers'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { getSession } from '../db/sessions-dao'
import { TsRuntimeWorkspaceAdmission } from '../runtime/ts-runtime-workspace-admission'
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

function workspaceSwitchBusyReason(): string | null {
  if (getNativeAgentRuntimeManager().hasRunAdmissionOrActiveRuns()) return 'WORKSPACE_BUSY_AGENT'
  if (hasActiveOrFinishingCronRuns()) return 'WORKSPACE_BUSY_CRON'
  if (hasActiveMainSshWorkspaceActivity()) return 'WORKSPACE_BUSY_SSH'
  return null
}

export function registerTsRuntimeHandlers(): void {
  const admission = new TsRuntimeWorkspaceAdmission()
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
      const reason = workspaceSwitchBusyReason()
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
    let releaseAgentAdmission: (() => void) | undefined
    let releaseTsAdmission: (() => void) | undefined
    let releaseCronAdmission: (() => void) | undefined
    let releaseDesktopFlowAdmission: (() => void) | undefined
    let releaseSshAdmission: (() => void) | undefined
    try {
      const { fromWorkspaceId, workspaceId } = parseRuntimeWorkspaceSwitchRequest(args)
      assertWindowWorkspace(event, fromWorkspaceId)
      releaseTsAdmission = admission.beginSwitch()
      releaseAgentAdmission = getNativeAgentRuntimeManager().beginWorkspaceSwitch()
      releaseCronAdmission = beginCronWorkspaceSwitch()
      releaseDesktopFlowAdmission = beginDesktopFlowWorkspaceSwitch()
      releaseSshAdmission = beginMainSshWorkspaceSwitch()
      const busyReason = workspaceSwitchBusyReason()
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
      releaseAgentAdmission?.()
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
}
