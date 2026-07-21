import type { HookEvent, HookInvocation } from '../../shared/hooks/types'
import { hooksService } from '../hooks/hooks-service'
import { registerMessagePackHandler } from './messagepack-handler'

export function registerHooksHandlers(): void {
  registerMessagePackHandler<{ projectPath?: string }>('hooks:list', ({ projectPath }) =>
    hooksService.list(projectPath)
  )
  registerMessagePackHandler<{ trustKey: string; projectPath?: string }>(
    'hooks:trust',
    async ({ trustKey, projectPath }) => {
      await hooksService.trust(trustKey, projectPath)
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
  }>('hooks:emit', ({ event, invocation }) => hooksService.emit(event, invocation))
}
