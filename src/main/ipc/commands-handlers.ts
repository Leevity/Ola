import { registerMessagePackHandler } from './messagepack-handler'
import { join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'
import {
  CommandCatalog,
  type CommandInfo,
  type CommandLoadResult,
  type CommandManageItem,
  type CommandManageReadResult,
  type CommandMutationResult
} from '../user-content/command-catalog'

export function registerCommandsHandlers(): void {
  const catalog = new CommandCatalog({
    userDirectory: join(olaDataRoot(), 'commands'),
    bundledDirectoryCandidates: getBundledResourceDirCandidates('commands')
  })
  void catalog.ensure().catch((error) => {
    console.warn(`[Commands] Failed to initialize user command directory: ${String(error)}`)
  })

  registerMessagePackHandler<undefined, { success: boolean; error?: string }>(
    'commands:ensure',
    async () => {
      try {
        await catalog.ensure()
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<undefined, CommandInfo[]>('commands:list', async () => {
    return await catalog.list()
  })

  registerMessagePackHandler<{ name: string }, CommandLoadResult>('commands:load', async (args) => {
    return await catalog.load(args.name)
  })

  registerMessagePackHandler<undefined, CommandManageItem[]>('commands:manage-list', async () => {
    return await catalog.manageList()
  })

  registerMessagePackHandler<{ path: string }, CommandManageReadResult>(
    'commands:manage-read',
    async (args) => {
      return await catalog.manageRead(args.path)
    }
  )

  registerMessagePackHandler<{ name: string; content?: string }, CommandMutationResult>(
    'commands:manage-create',
    async (args) => {
      return await catalog.manageCreate(args)
    }
  )

  registerMessagePackHandler<{ path: string; content: string }, CommandMutationResult>(
    'commands:manage-save',
    async (args) => {
      return await catalog.manageSave(args)
    }
  )
}
