import type { IPCClient } from '../tools/tool-types'
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

    if (shouldUseMessagePackInvoke(channel, args.length)) {
      return invokeMessagePackBinary(toMessagePackChannel(channel), args[0])
    }

    return ipcRenderer.invoke(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return

    if (shouldUseMessagePackSend(channel)) {
      const payload = args.length <= 1 ? args[0] : args
      ipcRenderer.send(toMessagePackChannel(channel), encodeMessagePackPayload(payload))
      return
    }

    ipcRenderer.send(channel, ...args)
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
