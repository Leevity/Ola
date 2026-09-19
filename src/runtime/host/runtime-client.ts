import { connect, type Socket } from 'node:net'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeError,
  type RuntimeCapability
} from '../../shared/runtime/contracts'
import { FrameDecoder, encodeFrame } from './framing'

export class RuntimeClient {
  private socket: Socket | null = null
  private nextId = 0
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private negotiated = new Set<RuntimeCapability>()
  get capabilities(): ReadonlySet<RuntimeCapability> {
    return this.negotiated
  }
  async connect(
    endpoint: string,
    token: string,
    requestedCapabilities: readonly RuntimeCapability[] = RUNTIME_CAPABILITIES
  ): Promise<void> {
    if (this.socket) throw new RuntimeError('ALREADY_CONNECTED')
    const socket = connect(endpoint)
    this.socket = socket
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!frame || typeof frame !== 'object') throw new RuntimeError('INVALID_RESPONSE')
          const message = frame as { id?: string; error?: string; result?: unknown }
          const request = this.pending.get(message.id ?? '')
          if (!request) continue
          this.pending.delete(message.id!)
          clearTimeout(request.timer)
          if (message.error) request.reject(new RuntimeError(message.error))
          else request.resolve(message.result)
        }
      } catch {
        this.close()
      }
    })
    socket.on('error', () => this.fail(new RuntimeError('RUNTIME_DISCONNECTED')))
    socket.on('close', () => {
      this.socket = null
      this.fail(new RuntimeError('RUNTIME_DISCONNECTED'))
    })
    try {
      const hello = await this.request<unknown>(
        'hello',
        { token, version: RUNTIME_PROTOCOL_VERSION, capabilities: requestedCapabilities },
        5000
      )
      if (!hello || typeof hello !== 'object' || Array.isArray(hello))
        throw new RuntimeError('INVALID_RESPONSE')
      const response = hello as { version?: unknown; capabilities?: unknown }
      if (response.version !== RUNTIME_PROTOCOL_VERSION || !Array.isArray(response.capabilities))
        throw new RuntimeError('INVALID_RESPONSE')
      const capabilities = response.capabilities.map((capability) => {
        if (
          typeof capability !== 'string' ||
          !RUNTIME_CAPABILITIES.includes(capability as RuntimeCapability) ||
          !requestedCapabilities.includes(capability as RuntimeCapability)
        )
          throw new RuntimeError('INVALID_RESPONSE')
        return capability as RuntimeCapability
      })
      if (new Set(capabilities).size !== capabilities.length)
        throw new RuntimeError('INVALID_RESPONSE')
      this.negotiated = new Set(capabilities)
    } catch (error) {
      this.close()
      throw error
    }
  }
  request<T>(method: string, params: unknown = {}, timeout = 15000): Promise<T> {
    if (!this.socket || this.socket.destroyed)
      return Promise.reject(new RuntimeError('RUNTIME_DISCONNECTED'))
    if (this.pending.size >= 32) return Promise.reject(new RuntimeError('TOO_MANY_REQUESTS'))
    const id = String(++this.nextId)
    const frame = encodeFrame({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RuntimeError('REQUEST_TIMEOUT'))
      }, timeout)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.socket!.write(frame)
    })
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.negotiated.clear()
    this.fail(new RuntimeError('RUNTIME_DISCONNECTED'))
  }
}
