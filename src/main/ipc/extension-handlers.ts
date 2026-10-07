import { shell } from 'electron'
import { registerMessagePackHandler } from './messagepack-handler'
import type { ExtensionInstance } from '../../shared/extension-types'
import {
  getExtensionPackageManager,
  getExtensionService,
  getExtensionStorage
} from '../extensions/extension-runtime'
import { executeExtensionHttpTool } from '../extensions/extension-http-tool'
import { readExtensionAsset } from '../extensions/extension-assets'

type MutationResult = {
  success: boolean
  error?: string
}

type ExtensionUpdateArgs = {
  id: string
  patch: {
    enabled?: boolean
    config?: Record<string, string>
  }
}

type ExtensionAssetArgs = {
  id: string
  path: string
}

type ExtensionStorageGetArgs = {
  extensionId: string
  key: string
}

type ExtensionStorageSetArgs = ExtensionStorageGetArgs & {
  value: unknown
}

function getExtensionId(args: string | { id?: string }): string {
  return typeof args === 'string' ? args : (args.id ?? '')
}

export function registerExtensionHandlers(): void {
  registerMessagePackHandler<undefined, ExtensionInstance[]>('extension:list', async () => {
    return await getExtensionService().list()
  })

  registerMessagePackHandler<{ sourcePath: string }, MutationResult>(
    'extension:install-from-folder',
    async (args) => {
      try {
        await getExtensionPackageManager().installFromFolder(args.sourcePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<ExtensionUpdateArgs, MutationResult>(
    'extension:update',
    async (args) => {
      try {
        await getExtensionService().update(args.id, args.patch)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<string | { id?: string }, MutationResult>(
    'extension:remove',
    async (args) => {
      try {
        await getExtensionPackageManager().remove(getExtensionId(args))
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<string | { id?: string }, MutationResult>(
    'extension:open-folder',
    async (args) => {
      try {
        const id = getExtensionId(args)
        await getExtensionService().getManifest(id)
        const error = await shell.openPath(getExtensionService().getPath(id))
        return error ? { success: false, error } : { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<string | { id?: string }, MutationResult & { path?: string }>(
    'extension:resolve-path',
    async (args) => {
      try {
        const id = getExtensionId(args)
        await getExtensionService().getManifest(id)
        return { success: true, path: getExtensionService().getPath(id) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<ExtensionAssetArgs, { content: string } | { error: string }>(
    'extension:read-asset',
    async (args) => {
      try {
        await getExtensionService().getManifest(args.id)
        return {
          content: await readExtensionAsset(getExtensionService().getPath(args.id), args.path)
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<
    { id: string; toolName: string; input?: Record<string, unknown> },
    unknown
  >('extension:execute-tool', async (args) => {
    try {
      const extension = await getExtensionService().getRuntime(args.id)
      return await executeExtensionHttpTool({
        manifest: extension.manifest,
        enabled: extension.enabled,
        config: extension.config,
        toolName: args.toolName,
        input: args.input
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  registerMessagePackHandler<ExtensionStorageGetArgs>('extension:storage-get', async (args) => {
    try {
      await getExtensionService().getManifest(args.extensionId)
      return await getExtensionStorage().get(args.extensionId, args.key)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  registerMessagePackHandler<ExtensionStorageSetArgs, MutationResult>(
    'extension:storage-set',
    async (args) => {
      try {
        await getExtensionService().getManifest(args.extensionId)
        await getExtensionStorage().set(args.extensionId, args.key, args.value)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<ExtensionStorageGetArgs, MutationResult>(
    'extension:storage-delete',
    async (args) => {
      try {
        await getExtensionService().getManifest(args.extensionId)
        await getExtensionStorage().delete(args.extensionId, args.key)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
