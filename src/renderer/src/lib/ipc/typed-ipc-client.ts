import type { IPCChannel } from '../../../../shared/ipc/contract'
import type { IpcResponseOf } from '../../../../shared/ipc/types'
import type { IPCClient } from '../tools/tool-types'

/**
 * Typed IPC facade over the legacy client.
 *
 * `invoke` infers its request and response from the per-channel schema in
 * `src/shared/ipc/types.ts`. Channels without a schema entry resolve to
 * `unknown` until their payload is pinned down.
 */
export class TypedIpcClient {
  constructor(private readonly client: IPCClient) {}

  invokeMessagePack<T = unknown>(channel: IPCChannel | string, payload: unknown): Promise<T> {
    if (this.client.invokeMessagePack) return this.client.invokeMessagePack<T>(channel, payload)
    return this.client.invoke(channel, payload) as Promise<T>
  }

  invoke<C extends IPCChannel | string = IPCChannel | string>(
    channel: C,
    ...args: unknown[]
  ): Promise<IpcResponseOf<C>> {
    return this.client.invoke(channel, ...args) as Promise<IpcResponseOf<C>>
  }

  send(channel: IPCChannel | string, ...args: unknown[]): void {
    this.client.send(channel, ...args)
  }

  on(channel: IPCChannel | string, listener: (...args: unknown[]) => void): () => void {
    return this.client.on(channel, listener)
  }
}

export function createTypedIpcClient(client: IPCClient): TypedIpcClient {
  return new TypedIpcClient(client)
}
