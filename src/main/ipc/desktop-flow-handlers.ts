import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'crypto'
import type {
  DesktopActionReceipt,
  DesktopFlow,
  DesktopFlowReplayResult
} from '../../shared/desktop-flow'
import {
  getActiveDesktopFlow,
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
import { deleteDesktopFlow, listDesktopFlows, saveDesktopFlow } from '../desktop/desktop-flow-store'
import {
  deletePersistedDesktopFlow,
  listPersistedDesktopFlows,
  persistDesktopFlow
} from '../db/capability-dao'

const MAX_REPLAY_STEPS = 1000
let activeReplayToken: symbol | null = null
let activeReplayOwnerId: number | null = null

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

export function registerDesktopFlowHandlers(): void {
  ipcMain.handle(
    'desktop-recorder:start',
    (event, args?: { name?: string; captureText?: boolean }) => {
      if (!isTrustedDesktopFlowIpcSender(event))
        throw new Error('Unauthorized desktop flow IPC sender')
      return startDesktopFlowRecording(args?.name, { captureText: args?.captureText })
    }
  )
  ipcMain.handle('desktop-recorder:pause', (event, args: { paused?: boolean }) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    return setDesktopFlowRecordingPaused(args?.paused === true)
  })
  ipcMain.handle('desktop-recorder:status', (event) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    return getDesktopFlowRecordingStatus()
  })
  ipcMain.handle('desktop-recorder:stop', (event) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    return stopDesktopFlowRecording()
  })
  ipcMain.handle('desktop-recorder:current', (event) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    return getActiveDesktopFlow()
  })
  ipcMain.handle('desktop-recorder:update', (event, flow: DesktopFlow) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    const error = validateFlow(flow, true)
    if (error) return null
    return updateActiveDesktopFlow(flow)
  })
  ipcMain.handle('desktop-flow:list', async (event) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    try {
      const persisted = await listPersistedDesktopFlows()
      const validPersisted = persisted.filter((flow) => validateFlow(flow, true) === null)
      if (validPersisted.length > 0) return validPersisted
    } catch (error) {
      console.warn('[DesktopFlow] Native persistence unavailable; using local fallback', error)
    }
    return listDesktopFlows()
  })
  ipcMain.handle('desktop-flow:save', async (event, flow: DesktopFlow) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    const saved = saveDesktopFlow(flow)
    try {
      await persistDesktopFlow(saved)
    } catch (error) {
      console.warn('[DesktopFlow] Native persistence unavailable; local fallback retained', error)
    }
    return saved
  })
  ipcMain.handle('desktop-flow:delete', async (event, args: { id: string }) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    const deleted = deleteDesktopFlow(args?.id)
    let nativeDeleted = false
    try {
      nativeDeleted = await deletePersistedDesktopFlow(args?.id)
    } catch (error) {
      console.warn('[DesktopFlow] Native deletion unavailable; local fallback retained', error)
    }
    return { success: deleted || nativeDeleted }
  })

  ipcMain.handle('desktop-flow:cancel', (event) => {
    if (!isTrustedDesktopFlowIpcSender(event))
      throw new Error('Unauthorized desktop flow IPC sender')
    if (activeReplayOwnerId !== event.sender.id) {
      return { success: false, error: 'Desktop flow replay is owned by another window.' }
    }
    activeReplayToken = null
    activeReplayOwnerId = null
    return { success: true }
  })

  ipcMain.handle(
    'desktop-flow:replay',
    async (
      event,
      args: { flow: DesktopFlow; approved?: boolean; verifyScreenshots?: boolean }
    ): Promise<DesktopFlowReplayResult> => {
      if (!isTrustedDesktopFlowIpcSender(event)) {
        return { success: false, error: 'Unauthorized desktop flow IPC sender' }
      }
      const flow = args?.flow
      const validationError = validateFlow(flow, args?.approved === true)
      if (validationError) return { success: false, error: validationError }
      if (activeReplayToken !== null) {
        return { success: false, error: 'Another desktop flow replay is already running.' }
      }

      const replayToken = Symbol('desktop-flow-replay')
      activeReplayToken = replayToken
      activeReplayOwnerId = event.sender.id
      event.sender.once('destroyed', () => {
        if (activeReplayToken === replayToken) {
          activeReplayToken = null
          activeReplayOwnerId = null
        }
      })
      const receipts: DesktopActionReceipt[] = []

      try {
        for (const step of flow.steps) {
          if (activeReplayToken !== replayToken) {
            return { success: false, error: 'Desktop flow replay cancelled.' }
          }
          if (step.type === 'wait') {
            await new Promise((resolve) => setTimeout(resolve, 500))
            continue
          }
          if (step.type === 'screenshot') {
            const screenshot = await captureDesktopScreenshot()
            if (!screenshot.success) return screenshot
            continue
          }
          const beforeHash = args?.verifyScreenshots === false ? null : await screenshotHash()
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
            return {
              success: false,
              error: `Unsupported desktop flow step: ${step.type}`,
              receipts
            }
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
          if (!result.success) return { ...result, receipts }
        }
        return { success: true, receipts }
      } finally {
        if (activeReplayToken === replayToken) {
          activeReplayToken = null
          activeReplayOwnerId = null
        }
      }
    }
  )
}
