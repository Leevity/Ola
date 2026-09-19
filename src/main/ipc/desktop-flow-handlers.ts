import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type MessageBoxOptions
} from 'electron'
import { createHash, randomUUID } from 'crypto'
import type {
  DesktopActionReceipt,
  DesktopFlow,
  DesktopFlowRun,
  DesktopFlowReplayResult
} from '../../shared/desktop-flow'
import {
  getActiveDesktopFlow,
  getDesktopFlowRecordingOwnerId,
  getDesktopFlowRecordingStatus,
  setDesktopFlowRecordingPaused,
  startDesktopFlowRecording,
  stopDesktopFlowRecording,
  updateActiveDesktopFlow
} from '../desktop/desktop-flow-recorder'
import {
  captureDesktopScreenshot,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType
} from './desktop-control'
import {
  deleteDesktopFlow,
  finishDesktopFlowRun,
  listDesktopFlowDeletions,
  listDesktopFlows,
  listDesktopFlowRuns,
  redactDesktopFlowCapturedText,
  saveDesktopFlow,
  startDesktopFlowRun
} from '../desktop/desktop-flow-store'
import {
  deletePersistedDesktopFlow,
  finishPersistedDesktopFlowRun,
  listPersistedDesktopFlowRuns,
  listPersistedDesktopFlows,
  persistDesktopFlow,
  startPersistedDesktopFlowRun
} from '../db/capability-dao'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { authorizeChannelSessionWorkspace } from '../channels/channel-session-workspace'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import {
  reconcileDesktopFlows,
  type DesktopFlowReconciliationCursor
} from '../desktop/desktop-flow-reconciliation'

const MAX_REPLAY_STEPS = 1000
let activeReplayToken: symbol | null = null
let cancelledReplayToken: symbol | null = null
let activeReplayOwnerId: number | null = null
let activeReplayWorkspaceId: string | null = null
let activeReplayFlowId: string | null = null
let workspaceSwitchPending = false
const pendingFlowDeletions = new Set<string>()
const pendingFlowSaves = new Set<string>()
const reconciliationCursors = new Map<string, DesktopFlowReconciliationCursor>()

function flowMutationKey(workspaceId: string, flowId: string): string {
  return JSON.stringify([workspaceId, flowId])
}

export function isDesktopFlowActiveForSender(senderId: number): boolean {
  return getDesktopFlowRecordingOwnerId() === senderId || activeReplayOwnerId === senderId
}

export function beginDesktopFlowWorkspaceSwitch(): () => void {
  if (workspaceSwitchPending || getActiveDesktopFlow() !== null || activeReplayToken !== null)
    throw new Error('WORKSPACE_BUSY_DESKTOP_FLOW')
  workspaceSwitchPending = true
  let released = false
  return () => {
    if (released) return
    released = true
    workspaceSwitchPending = false
  }
}

async function screenshotHash(): Promise<string | null> {
  const result = await captureDesktopScreenshot()
  if (!result.success || !result.data) return null
  return createHash('sha256').update(result.data, 'base64').digest('hex')
}

function isTrustedDesktopFlowIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

async function authorizeDesktopFlowWorkspace(
  event: IpcMainInvokeEvent,
  requestedWorkspaceId: unknown
): Promise<string> {
  if (!isTrustedDesktopFlowIpcSender(event)) throw new Error('Unauthorized desktop flow IPC sender')
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const registeredWorkspaceId = ownerWindow && getRegisteredWindowWorkspace(ownerWindow)
  if (!registeredWorkspaceId || requestedWorkspaceId !== registeredWorkspaceId)
    throw new Error('DESKTOP_FLOW_WORKSPACE_UNAVAILABLE')
  return authorizeChannelSessionWorkspace(registeredWorkspaceId, loadOfflineWorkspaceIds)
}

function assertRecordingOwner(event: IpcMainInvokeEvent, workspaceId: string): void {
  const active = getActiveDesktopFlow()
  if (
    active &&
    (getDesktopFlowRecordingOwnerId() !== event.sender.id ||
      (active.workspaceId ?? 'local-personal') !== workspaceId)
  )
    throw new Error('DESKTOP_FLOW_RECORDING_UNAVAILABLE')
}

function validateFlow(flow: DesktopFlow, allowHighRisk = false): string | null {
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.steps)) {
    return 'Invalid desktop flow.'
  }
  if (flow.steps.length > MAX_REPLAY_STEPS) return 'Desktop flow has too many steps.'
  for (const step of flow.steps) {
    if (!step || typeof step !== 'object' || typeof step.type !== 'string') {
      return 'Desktop flow contains an invalid step.'
    }
    if (
      !['screenshot', 'click', 'double_click', 'type', 'keypress', 'scroll', 'wait'].includes(
        step.type
      )
    ) {
      return `Unsupported desktop flow step: ${step.type}`
    }
    if (step.riskLevel === 'high' && !allowHighRisk) {
      return 'High-risk desktop steps require explicit approval.'
    }
    if (typeof step.text === 'string' && step.text.length > 100_000) {
      return 'Desktop flow text is too large.'
    }
    if (
      step.keys &&
      (!Array.isArray(step.keys) ||
        step.keys.length > 16 ||
        step.keys.some((key) => typeof key !== 'string' || key.length > 32))
    ) {
      return 'Desktop flow key sequence is invalid.'
    }
  }
  return null
}

function requiresLegacyFlowReview(flow: DesktopFlow): boolean {
  return flow.requiresReview === true || flow.steps.some((step) => step.type === 'type')
}

async function confirmDesktopReplay(
  event: IpcMainInvokeEvent,
  flow: DesktopFlow
): Promise<boolean> {
  // Risk metadata is supplied with the flow and cannot authorize desktop input by itself.
  const controlSteps = flow.steps.filter(
    (step) =>
      step.riskLevel === 'high' ||
      ['click', 'double_click', 'type', 'keypress', 'scroll'].includes(step.type)
  )
  if (controlSteps.length === 0) return true
  const owner = BrowserWindow.fromWebContents(event.sender)
  const digest = createHash('sha256').update(JSON.stringify(flow)).digest('hex').slice(0, 12)
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Cancel', 'Run desktop steps'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Confirm desktop automation',
    message: `Run ${controlSteps.length} desktop control step(s)?`,
    detail: `Flow: ${flow.name}\nIntegrity ID: ${digest}\nThe flow may type text or control another application.`
  }
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

export function registerDesktopFlowHandlers(): void {
  ipcMain.handle('desktop-flow:activity', async (event, args?: { workspaceId?: string }) => {
    await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    return { busy: getActiveDesktopFlow() !== null || activeReplayToken !== null }
  })
  ipcMain.handle(
    'desktop-recorder:start',
    async (event, args?: { name?: string; captureText?: boolean; workspaceId?: string }) => {
      const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
      if (workspaceSwitchPending) throw new Error('WORKSPACE_BUSY_DESKTOP_FLOW')
      const flow = startDesktopFlowRecording(args?.name, {
        captureText: args?.captureText,
        workspaceId,
        ownerId: event.sender.id
      })
      const ownerId = event.sender.id
      event.sender.once('destroyed', () => {
        if (getDesktopFlowRecordingOwnerId() === ownerId) stopDesktopFlowRecording()
      })
      return flow
    }
  )
  ipcMain.handle(
    'desktop-recorder:pause',
    async (event, args: { paused?: boolean; workspaceId?: string }) => {
      const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
      assertRecordingOwner(event, workspaceId)
      return setDesktopFlowRecordingPaused(args?.paused === true)
    }
  )
  ipcMain.handle('desktop-recorder:status', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    assertRecordingOwner(event, workspaceId)
    return getDesktopFlowRecordingStatus()
  })
  ipcMain.handle('desktop-recorder:stop', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    assertRecordingOwner(event, workspaceId)
    return stopDesktopFlowRecording()
  })
  ipcMain.handle('desktop-recorder:current', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    assertRecordingOwner(event, workspaceId)
    return getActiveDesktopFlow()
  })
  ipcMain.handle('desktop-recorder:update', async (event, flow: DesktopFlow) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, flow?.workspaceId)
    assertRecordingOwner(event, workspaceId)
    const error = validateFlow(flow, true)
    if (error) return null
    return updateActiveDesktopFlow(flow)
  })
  ipcMain.handle('desktop-flow:list', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    let persisted: DesktopFlow[] = []
    try {
      persisted = (await listPersistedDesktopFlows(workspaceId))
        .filter(
          (flow) =>
            validateFlow(flow, true) === null &&
            (flow.workspaceId ?? 'local-personal') === workspaceId
        )
        .map(redactDesktopFlowCapturedText)
      await Promise.all(
        persisted
          .filter((flow) => flow.requiresReview)
          .map((flow) =>
            persistDesktopFlow(flow, workspaceId).catch((error) => {
              console.warn('[DesktopFlow] Failed to sanitize Native flow', error)
            })
          )
      )
    } catch (error) {
      console.warn('[DesktopFlow] Native persistence unavailable; using local fallback', error)
    }
    const local = listDesktopFlows(workspaceId)
    const deleted = new Set(listDesktopFlowDeletions(workspaceId))
    const merged = new Map(persisted.map((flow) => [flow.id, flow]))
    for (const flow of local) {
      const existing = merged.get(flow.id)
      if (!existing || flow.updatedAt > existing.updatedAt) merged.set(flow.id, flow)
    }
    await authorizeDesktopFlowWorkspace(event, workspaceId)
    return [...merged.values()]
      .filter((flow) => !deleted.has(flow.id))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 100)
  })
  ipcMain.handle('desktop-flow:runs-list', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    let runs: DesktopFlowRun[] = []
    try {
      runs = await listPersistedDesktopFlowRuns(workspaceId)
    } catch (error) {
      console.warn('[DesktopFlow] Run history unavailable; keeping local flows visible', error)
    }
    const localRuns = listDesktopFlowRuns(workspaceId)
    const deleted = new Set(listDesktopFlowDeletions(workspaceId))
    await authorizeDesktopFlowWorkspace(event, workspaceId)
    return [...new Map([...runs, ...localRuns].map((run) => [run.id, run])).values()]
      .filter((run) => !deleted.has(run.flowId))
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 100)
  })
  ipcMain.handle('desktop-flow:sync', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    try {
      const cursor = reconciliationCursors.get(workspaceId) ?? { afterKey: null }
      const result = await reconcileDesktopFlows(
        {
          authorize: async () => {
            await authorizeDesktopFlowWorkspace(event, workspaceId)
          },
          listNativeFlows: () => listPersistedDesktopFlows(workspaceId),
          saveNativeFlow: async (flow) => {
            const key = flowMutationKey(workspaceId, flow.id)
            if (
              pendingFlowSaves.has(key) ||
              pendingFlowDeletions.has(key) ||
              (activeReplayWorkspaceId === workspaceId && activeReplayFlowId === flow.id)
            )
              throw new Error('DESKTOP_FLOW_MUTATION_ACTIVE')
            pendingFlowSaves.add(key)
            try {
              await persistDesktopFlow(flow, workspaceId)
            } finally {
              pendingFlowSaves.delete(key)
            }
          },
          deleteNativeFlow: async (id) => {
            const key = flowMutationKey(workspaceId, id)
            if (
              pendingFlowSaves.has(key) ||
              pendingFlowDeletions.has(key) ||
              (activeReplayWorkspaceId === workspaceId && activeReplayFlowId === id)
            )
              throw new Error('DESKTOP_FLOW_MUTATION_ACTIVE')
            pendingFlowDeletions.add(key)
            try {
              return await deletePersistedDesktopFlow(id, workspaceId)
            } finally {
              pendingFlowDeletions.delete(key)
            }
          },
          listNativeRuns: () => listPersistedDesktopFlowRuns(workspaceId, 10_000),
          startNativeRun: (run) =>
            startPersistedDesktopFlowRun(run.id, run.flowId, workspaceId, run.startedAt),
          finishNativeRun: (run) =>
            finishPersistedDesktopFlowRun(
              run.id,
              workspaceId,
              run.state as 'succeeded' | 'failed' | 'cancelled',
              run.errorMessage,
              run.finishedAt ?? Date.now()
            ),
          listLocalFlows: () => listDesktopFlows(workspaceId),
          listLocalDeletions: () => listDesktopFlowDeletions(workspaceId),
          listLocalRuns: () => listDesktopFlowRuns(workspaceId, Number.MAX_SAFE_INTEGER)
        },
        cursor
      )
      await authorizeDesktopFlowWorkspace(event, workspaceId)
      reconciliationCursors.set(workspaceId, cursor)
      return { available: true, ...result }
    } catch (error) {
      console.warn('[DesktopFlow] Offline reconciliation unavailable', error)
      await authorizeDesktopFlowWorkspace(event, workspaceId)
      return { available: false, savedFlows: 0, deletedFlows: 0, savedRuns: 0, failed: 0 }
    }
  })
  ipcMain.handle('desktop-flow:save', async (event, flow: DesktopFlow) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(
      event,
      flow?.workspaceId ?? 'local-personal'
    )
    const validationError = validateFlow(flow, true)
    if (validationError) throw new Error(validationError)
    if (activeReplayWorkspaceId === workspaceId && activeReplayFlowId === flow.id)
      throw new Error('DESKTOP_FLOW_REPLAY_ACTIVE')
    const mutationKey = flowMutationKey(workspaceId, flow.id)
    if (pendingFlowDeletions.has(mutationKey) || pendingFlowSaves.has(mutationKey))
      throw new Error('DESKTOP_FLOW_MUTATION_ACTIVE')
    pendingFlowSaves.add(mutationKey)
    const safeFlow = redactDesktopFlowCapturedText(flow)
    try {
      try {
        await persistDesktopFlow(safeFlow, workspaceId)
      } catch (error) {
        if (
          error instanceof Error &&
          /belongs to another workspace|workspace mismatch/i.test(error.message)
        )
          throw error
        console.warn('[DesktopFlow] Native persistence unavailable; local fallback retained', error)
      }
      await authorizeDesktopFlowWorkspace(event, workspaceId)
      const saved = saveDesktopFlow(safeFlow, workspaceId)
      await authorizeDesktopFlowWorkspace(event, workspaceId)
      return saved
    } finally {
      pendingFlowSaves.delete(mutationKey)
    }
  })
  ipcMain.handle(
    'desktop-flow:delete',
    async (event, args: { id: string; workspaceId?: string }) => {
      const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
      if (activeReplayWorkspaceId === workspaceId && activeReplayFlowId === args?.id)
        throw new Error('DESKTOP_FLOW_REPLAY_ACTIVE')
      const mutationKey = flowMutationKey(workspaceId, args?.id)
      if (pendingFlowDeletions.has(mutationKey) || pendingFlowSaves.has(mutationKey))
        throw new Error('DESKTOP_FLOW_MUTATION_ACTIVE')
      pendingFlowDeletions.add(mutationKey)
      try {
        const deleted = deleteDesktopFlow(args?.id, workspaceId)
        let nativeDeleted = false
        try {
          nativeDeleted = await deletePersistedDesktopFlow(args?.id, workspaceId)
        } catch (error) {
          console.warn('[DesktopFlow] Native deletion unavailable; local fallback retained', error)
        }
        await authorizeDesktopFlowWorkspace(event, workspaceId)
        return { success: deleted || nativeDeleted }
      } finally {
        pendingFlowDeletions.delete(mutationKey)
      }
    }
  )

  ipcMain.handle('desktop-flow:cancel', async (event, args?: { workspaceId?: string }) => {
    const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
    if (activeReplayOwnerId !== event.sender.id || activeReplayWorkspaceId !== workspaceId) {
      return { success: false, error: 'Desktop flow replay is owned by another window.' }
    }
    cancelledReplayToken = activeReplayToken
    return { success: true }
  })

  ipcMain.handle(
    'desktop-flow:replay',
    async (
      event,
      args: { flow: DesktopFlow; workspaceId?: string; verifyScreenshots?: boolean }
    ): Promise<DesktopFlowReplayResult> => {
      const workspaceId = await authorizeDesktopFlowWorkspace(event, args?.workspaceId)
      const flow = args?.flow
      const validationError = validateFlow(flow, true)
      if (validationError) return { success: false, error: validationError }
      if ((flow.workspaceId ?? 'local-personal') !== workspaceId)
        return { success: false, error: 'DESKTOP_FLOW_WORKSPACE_UNAVAILABLE' }
      if (getActiveDesktopFlow())
        return { success: false, error: 'Stop desktop flow recording before replay.' }
      if (requiresLegacyFlowReview(flow)) {
        return {
          success: false,
          error:
            'This flow contains typing steps that cannot be safely replayed. Re-record without typing before replaying it.'
        }
      }
      if (!(await confirmDesktopReplay(event, flow))) {
        return { success: false, error: 'Desktop flow was not approved by the user.' }
      }
      await authorizeDesktopFlowWorkspace(event, workspaceId)
      if (workspaceSwitchPending) return { success: false, error: 'WORKSPACE_BUSY_DESKTOP_FLOW' }
      if (pendingFlowDeletions.has(flowMutationKey(workspaceId, flow.id))) {
        return { success: false, error: 'Desktop flow deletion is still in progress.' }
      }
      if (pendingFlowSaves.has(flowMutationKey(workspaceId, flow.id))) {
        return { success: false, error: 'Desktop flow save is still in progress.' }
      }
      if (activeReplayToken !== null) {
        return { success: false, error: 'Another desktop flow replay is already running.' }
      }

      const replayToken = Symbol('desktop-flow-replay')
      activeReplayToken = replayToken
      cancelledReplayToken = null
      activeReplayOwnerId = event.sender.id
      activeReplayWorkspaceId = workspaceId
      activeReplayFlowId = flow.id
      event.sender.once('destroyed', () => {
        if (activeReplayToken === replayToken) {
          cancelledReplayToken = replayToken
        }
      })
      const receipts: DesktopActionReceipt[] = []
      const runId = randomUUID()
      const runStartedAt = Date.now()
      let runStore: 'native' | 'file' | null = null
      const audit: { replayResult: DesktopFlowReplayResult | null; replayError: string | null } = {
        replayResult: null,
        replayError: null
      }
      const withReplayResult = (value: DesktopFlowReplayResult): DesktopFlowReplayResult => {
        audit.replayResult = value
        return value
      }

      try {
        try {
          await startPersistedDesktopFlowRun(runId, flow.id, workspaceId, runStartedAt)
          runStore = 'native'
        } catch (error) {
          console.warn('[DesktopFlow] Run audit start unavailable', error)
          try {
            startDesktopFlowRun(runId, flow.id, workspaceId, runStartedAt)
            runStore = 'file'
          } catch (fallbackError) {
            console.warn('[DesktopFlow] Local run audit start unavailable', fallbackError)
          }
        }
        for (const step of flow.steps) {
          await authorizeDesktopFlowWorkspace(event, workspaceId)
          if (activeReplayToken !== replayToken || cancelledReplayToken === replayToken) {
            return withReplayResult({ success: false, error: 'Desktop flow replay cancelled.' })
          }
          if (step.type === 'wait') {
            await new Promise((resolve) => setTimeout(resolve, 500))
            continue
          }
          if (step.type === 'screenshot') {
            const screenshot = await captureDesktopScreenshot()
            if (!screenshot.success) return withReplayResult(screenshot)
            continue
          }
          const beforeHash = args?.verifyScreenshots === false ? null : await screenshotHash()
          // Screenshot capture is asynchronous; authorization may be revoked before input is sent.
          await authorizeDesktopFlowWorkspace(event, workspaceId)
          if (activeReplayToken !== replayToken || cancelledReplayToken === replayToken) {
            return withReplayResult({
              success: false,
              error: 'Desktop flow replay cancelled.',
              receipts
            })
          }
          let result: { success: true; [key: string]: unknown } | { success: false; error: string }
          if (step.type === 'click' || step.type === 'double_click') {
            result = desktopInputClick({
              x: step.x ?? 0,
              y: step.y ?? 0,
              button: step.button,
              action: step.type === 'double_click' ? 'double_click' : 'click'
            })
          } else if (step.type === 'type') {
            result = desktopInputType({ text: step.text ?? '' })
          } else if (step.type === 'keypress') {
            result = desktopInputType({
              key: step.key,
              hotkey: step.keys,
              action: step.keys?.length ? undefined : 'down'
            })
          } else if (step.type === 'scroll') {
            result = desktopInputScroll({
              x: step.x,
              y: step.y,
              scrollX: step.scrollX,
              scrollY: step.scrollY
            })
          } else {
            return withReplayResult({
              success: false,
              error: `Unsupported desktop flow step: ${step.type}`,
              receipts
            })
          }
          const afterHash = args?.verifyScreenshots === false ? null : await screenshotHash()
          receipts.push({
            stepId: step.id,
            success: result.success,
            beforeHash,
            afterHash,
            changed: beforeHash !== null && afterHash !== null && beforeHash !== afterHash,
            error: result.success ? undefined : result.error
          })
          if (!result.success) return withReplayResult({ ...result, receipts })
        }
        await authorizeDesktopFlowWorkspace(event, workspaceId)
        if (activeReplayToken !== replayToken || cancelledReplayToken === replayToken)
          return withReplayResult({
            success: false,
            error: 'Desktop flow replay cancelled.',
            receipts
          })
        return withReplayResult({ success: true, receipts })
      } catch (error) {
        audit.replayError = error instanceof Error ? error.message : 'Desktop flow replay failed.'
        throw error
      } finally {
        if (runStore) {
          const errorMessage = audit.replayError ?? audit.replayResult?.error ?? null
          const state = audit.replayResult?.success
            ? 'succeeded'
            : cancelledReplayToken === replayToken || errorMessage?.includes('cancelled')
              ? 'cancelled'
              : 'failed'
          if (runStore === 'native') {
            let finished = false
            try {
              finished = await finishPersistedDesktopFlowRun(
                runId,
                workspaceId,
                state,
                errorMessage
              )
            } catch (error) {
              console.warn('[DesktopFlow] Run audit finish unavailable', error)
            }
            if (!finished) {
              try {
                startDesktopFlowRun(runId, flow.id, workspaceId, runStartedAt)
                finishDesktopFlowRun(runId, workspaceId, state, Date.now(), errorMessage)
              } catch (fallbackError) {
                console.warn('[DesktopFlow] Local run audit recovery unavailable', fallbackError)
              }
            }
          } else {
            try {
              finishDesktopFlowRun(runId, workspaceId, state, Date.now(), errorMessage)
            } catch (error) {
              console.warn('[DesktopFlow] Local run audit finish unavailable', error)
            }
          }
        }
        if (activeReplayToken === replayToken) {
          activeReplayToken = null
          cancelledReplayToken = null
          activeReplayOwnerId = null
          activeReplayWorkspaceId = null
          activeReplayFlowId = null
        }
      }
    }
  )
}
