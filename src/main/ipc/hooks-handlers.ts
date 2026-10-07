import type { HookEvent, HookInvocation } from '../../shared/hooks/types'
import { hooksService } from '../hooks/hooks-service'
import { getSession } from '../db/sessions-dao'
import { getRegisteredWindowWorkspace, getTrustedWorkspaceRegistrationWindow } from '../window-ipc'
import { registerMessagePackHandler } from './messagepack-handler'

async function hookProjectPath(
  sessionId: string | undefined,
  ipcEvent: Parameters<typeof getTrustedWorkspaceRegistrationWindow>[0]
): Promise<string | undefined> {
  if (!sessionId) return undefined
  const window = getTrustedWorkspaceRegistrationWindow(ipcEvent)
  const workspaceId = window ? getRegisteredWindowWorkspace(window) : null
  if (!workspaceId) throw new Error('WINDOW_WORKSPACE_UNAVAILABLE')
  const session = await getSession(sessionId, workspaceId)
  if (!session) throw new Error('HOOK_SESSION_WORKSPACE_MISMATCH')
  return session.ssh_connection_id ? undefined : (session.working_folder ?? undefined)
}

export function registerHooksHandlers(): void {
  registerMessagePackHandler<{ sessionId?: string }>('hooks:list', async ({ sessionId }, event) =>
    hooksService.list(await hookProjectPath(sessionId, event))
  )
  registerMessagePackHandler<{ trustKey: string; sessionId?: string }>(
    'hooks:trust',
    async ({ trustKey, sessionId }, event) => {
      await hooksService.trust(trustKey, await hookProjectPath(sessionId, event))
      return { success: true }
    }
  )
  registerMessagePackHandler<{ trustKey: string }>('hooks:revoke', async ({ trustKey }) => {
    await hooksService.revoke(trustKey)
    return { success: true }
  })
  registerMessagePackHandler('hooks:history', () => hooksService.history())
  registerMessagePackHandler<{ key: string }>('hooks:cancel', ({ key }) => {
    hooksService.cancel(key)
    return { success: true }
  })
  registerMessagePackHandler<{
    event: HookEvent
    invocation: Omit<HookInvocation, 'event' | 'version'>
  }>('hooks:emit', async ({ event, invocation }, ipcEvent) => {
    const window = getTrustedWorkspaceRegistrationWindow(ipcEvent)
    const workspaceId = window ? getRegisteredWindowWorkspace(window) : null
    if (!workspaceId) throw new Error('WINDOW_WORKSPACE_UNAVAILABLE')
    const session = await getSession(invocation.sessionId, workspaceId)
    if (!session) throw new Error('HOOK_SESSION_WORKSPACE_MISMATCH')
    if (session.scenario_policy) return []
    return hooksService.emit(event, {
      ...invocation,
      projectPath: session.ssh_connection_id ? undefined : (session.working_folder ?? undefined)
    })
  })
}
