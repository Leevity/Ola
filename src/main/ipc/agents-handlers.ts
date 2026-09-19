import { registerMessagePackHandler } from './messagepack-handler'
import { join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'
import {
  AgentCatalog,
  type AgentInfo,
  type AgentManageItem,
  type AgentManageReadResult,
  type AgentMutationResult
} from '../user-content/agent-catalog'

export function registerAgentsHandlers(): void {
  const catalog = new AgentCatalog({
    userDirectory: join(olaDataRoot(), 'agents'),
    bundledDirectoryCandidates: getBundledResourceDirCandidates('agents')
  })
  void catalog.ensure().then((result) => {
    if (!result.success)
      console.warn(`[Agents] Failed to initialize user agent directory: ${result.error}`)
  })

  registerMessagePackHandler<undefined, AgentInfo[]>('agents:list', async () => {
    return await catalog.list()
  })

  registerMessagePackHandler<{ name: string }, AgentInfo | { error: string }>(
    'agents:load',
    async (args) => {
      return await catalog.load(args.name)
    }
  )

  registerMessagePackHandler<undefined, AgentManageItem[]>('agents:manage-list', async () => {
    return await catalog.manageList()
  })

  registerMessagePackHandler<{ path: string }, AgentManageReadResult>(
    'agents:manage-read',
    async (args) => {
      return await catalog.manageRead(args.path)
    }
  )

  registerMessagePackHandler<{ path: string; content: string }, AgentMutationResult>(
    'agents:manage-save',
    async (args) => {
      return await catalog.manageSave(args)
    }
  )
}
