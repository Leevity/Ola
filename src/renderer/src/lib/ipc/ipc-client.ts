import type { IPCClient } from '../tools/tool-types'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../../../shared/messagepack/binary-ipc'
import { invokeMessagePackBinary } from './messagepack-ipc-client'
import {
  shouldUseMessagePackEvent,
  shouldUseMessagePackInvoke,
  shouldUseMessagePackSend
} from './messagepack-channel-routing'

/**
 * IPC Client wrapper for renderer process.
 * Uses the domain-scoped Ola preload bridge.
 */
class ElectronIPCClient implements IPCClient {
  private get ipcRenderer(): typeof window.ola.ipc | null {
    return window.ola?.ipc ?? null
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) {
      throw new Error(`IPC channel "${channel}" is unavailable: Electron preload bridge is missing`)
    }

    const scopedArgs =
      channel.startsWith('ssh:') ||
      channel.startsWith('git:') ||
      channel.startsWith('plugin:sessions:') ||
      channel === 'plugin:exec' ||
      channel.startsWith('plugin:feishu:')
        ? [
            {
              ...(args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {}),
              ...(channel === 'plugin:sessions:list' && typeof args[0] === 'string'
                ? { pluginId: args[0] }
                : {}),
              ...(channel === 'plugin:sessions:find-by-chat' && typeof args[0] === 'string'
                ? { externalChatId: args[0] }
                : {}),
              workspaceId: useWorkspaceStore.getState().activeWorkspaceId
            }
          ]
        : args
    if (shouldUseMessagePackInvoke(channel, scopedArgs.length)) {
      return invokeMessagePackBinary(toMessagePackChannel(channel), scopedArgs[0])
    }

    return ipcRenderer.invoke(channel, ...scopedArgs)
  }

  send(channel: string, ...args: unknown[]): void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return

    const scopedArgs =
      channel.startsWith('ssh:') || channel.startsWith('git:')
        ? [
            {
              ...(args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {}),
              workspaceId: useWorkspaceStore.getState().activeWorkspaceId
            }
          ]
        : args

    if (shouldUseMessagePackSend(channel)) {
      const payload = scopedArgs.length <= 1 ? scopedArgs[0] : scopedArgs
      ipcRenderer.send(toMessagePackChannel(channel), encodeMessagePackPayload(payload))
      return
    }

    ipcRenderer.send(channel, ...scopedArgs)
  }

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return () => {}

    if (shouldUseMessagePackEvent(channel)) {
      const handler = (bytes: unknown): void => {
        if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return
        callback(decodeMessagePackPayload(bytes))
      }
      const binaryChannel = toMessagePackChannel(channel)
      return ipcRenderer.on(binaryChannel, handler)
    }

    const handler = (...args: unknown[]): void => {
      callback(...args)
    }
    return ipcRenderer.on(channel, handler)
  }
}

export const ipcClient: IPCClient = new ElectronIPCClient()
