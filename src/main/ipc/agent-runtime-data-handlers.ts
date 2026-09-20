import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { registerMessagePackHandler } from './messagepack-handler'
import { businessWriteCanary } from '../db/business-write-canary'
import { addMessages, type MessageInput } from '../db/messages-dao'
import { getSession } from '../db/sessions-dao'
import { getRegisteredWindowWorkspace } from '../window-ipc'

function trusted(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    window &&
    !window.isDestroyed() &&
    window.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error(`INVALID_${name}`)
  return value.trim()
}

/** TS-owned durable Agent data routes; no legacy reverse-request reader is involved. */
export function registerAgentRuntimeDataHandlers(): void {
  registerMessagePackHandler<{
    workspaceId: string
    sessionId: string
    messages: MessageInput[]
  }>('agent:append-messages', async (args, event) => {
    if (!trusted(event)) return { success: false, error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const workspaceId = text(args?.workspaceId, 'WORKSPACE')
      const sessionId = text(args?.sessionId, 'SESSION')
      if (
        getRegisteredWindowWorkspace(BrowserWindow.fromWebContents(event.sender)!) !== workspaceId
      )
        throw new Error('WINDOW_WORKSPACE_MISMATCH')
      if (!Array.isArray(args?.messages) || args.messages.length > 256)
        throw new Error('INVALID_MESSAGES')
      if (args.messages.some((message) => message.sessionId !== sessionId))
        throw new Error('SESSION_WORKSPACE_MISMATCH')
      if (!(await getSession(sessionId, workspaceId))) throw new Error('SESSION_NOT_FOUND')
      await addMessages(args.messages)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'RUNTIME_DATA_UNAVAILABLE'
      }
    }
  })

  registerMessagePackHandler<{
    workspaceId: string
    sessionId: string
    toolUseIds: string[]
  }>('agent:tool-results-lookup', async (args, event) => {
    if (!trusted(event)) return { results: [], error: 'UNAUTHORIZED_IPC_SENDER' }
    try {
      const workspaceId = text(args?.workspaceId, 'WORKSPACE')
      const sessionId = text(args?.sessionId, 'SESSION')
      if (
        getRegisteredWindowWorkspace(BrowserWindow.fromWebContents(event.sender)!) !== workspaceId
      )
        throw new Error('WINDOW_WORKSPACE_MISMATCH')
      if (!Array.isArray(args?.toolUseIds) || args.toolUseIds.length > 256)
        throw new Error('INVALID_TOOL_USE_IDS')
      const toolUseIds = args.toolUseIds.map((id) => text(id, 'TOOL_USE'))
      const repository = businessWriteCanary()
      if (!repository) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
      const results = await repository.runtimeToolResults(sessionId, workspaceId, toolUseIds)
      return { results }
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : 'RUNTIME_DATA_UNAVAILABLE'
      }
    }
  })
}
