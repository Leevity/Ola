import { shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { registerMessagePackHandler } from './messagepack-handler'
import type { ExtensionInstance } from '../../shared/extension-types'
import { nativeExtensionRequest } from './extension-native-bridge'
import { getExtensionService, getExtensionStorage } from '../extensions/extension-runtime'

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
    return await nativeExtensionRequest<ExtensionInstance[]>('extension/list')
  })

  registerMessagePackHandler<{ sourcePath: string }, MutationResult>(
    'extension:install-from-folder',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/install-from-folder', args)
    }
  )

  registerMessagePackHandler<ExtensionUpdateArgs, MutationResult>(
    'extension:update',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/update', args)
    }
  )

  registerMessagePackHandler<string | { id?: string }, MutationResult>(
    'extension:remove',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/remove', {
        id: getExtensionId(args)
      })
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

  registerMessagePackHandler<ExtensionAssetArgs, { content: string } | { error: string }>(
    'extension:read-asset',
    async (args) => {
      try {
        await getExtensionService().getManifest(args.id)
        return {
          content: await readFile(getExtensionService().getAssetPath(args.id, args.path), 'utf8')
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

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
