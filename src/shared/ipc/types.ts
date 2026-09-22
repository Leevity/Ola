import type { IPCChannel } from './contract'

export type IpcTransport = 'json' | 'msgpack'
export type IpcWorkspaceScope = 'none' | 'required' | 'optional'
export type IpcSenderScope = 'primary-window' | 'trusted-window' | 'any-trusted'

export interface IpcChannelMetadata {
  transport: IpcTransport
  workspace: IpcWorkspaceScope
  sender: IpcSenderScope
  permission?: string
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

export type TypedIpcInvoke = <T = unknown>(
  channel: IPCChannel,
  ...args: unknown[]
) => Promise<T>

export type TypedIpcSend = (channel: IPCChannel, ...args: unknown[]) => void
export type TypedIpcListener = (channel: IPCChannel, listener: (...args: unknown[]) => void) => () => void

/**
 * Per-channel request/response contract. This is the evolving registry that
 * pins down the payload shape for every registered channel. Entries default
 * to `unknown` until a handler is typed; adding a channel here is required
 * before strict typing is enforced for that channel.
 */
export interface IpcChannelSchema {
  request: unknown
  response: unknown
}

export const ipcChannelSchema: Record<string, IpcChannelSchema> = {
  'settings:get': { request: { key: 'string' }, response: { value: 'unknown' } },
  'settings:update': { request: { key: 'string', value: 'unknown' }, response: { ok: 'boolean' } },
  'sessions:list': { request: { workspaceId: 'string' }, response: { sessions: 'Session[]' } },
  'sessions:get': { request: { sessionId: 'string' }, response: { session: 'Session | null' } },
  'sessions:create': { request: { workspaceId: 'string', mode: 'string' }, response: { session: 'Session' } },
  'sessions:update': { request: { sessionId: 'string', patch: 'unknown' }, response: { ok: 'boolean' } },
  'sessions:delete': { request: { sessionId: 'string' }, response: { ok: 'boolean' } },
  'db:messages:list': { request: { sessionId: 'string', cursor: 'string | undefined' }, response: { messages: 'UnifiedMessage[]' } },
  'db:messages:update': { request: { messageId: 'string', patch: 'unknown' }, response: { ok: 'boolean' } },
  'fs:read': { request: { path: 'string' }, response: { content: 'string' } },
  'fs:write': { request: { path: 'string', content: 'string' }, response: { ok: 'boolean' } },
  'shell:execute': { request: { command: 'string', cwd: 'string | undefined' }, response: { output: 'string' } },
  'runtime:submit': { request: { workspaceId: 'string', sessionId: 'string', text: 'string' }, response: { runId: 'string' } },
  'runtime:cancel': { request: { runId: 'string' }, response: { ok: 'boolean' } },
  'ts-runtime:run-submit': { request: { workspaceId: 'string', sessionId: 'string', text: 'string' }, response: { runId: 'string' } },
  'browser:execute-script': { request: { target: 'unknown', script: 'string' }, response: { result: 'unknown' } },
  'credential:read-plaintext': { request: { credentialId: 'string' }, response: { secret: 'string' } },
  'credential:inject': { request: { credentialId: 'string', target: 'string' }, response: { ok: 'boolean' } },
  'git:status': { request: { workspaceId: 'string' }, response: { status: 'unknown' } },
  'image:download': { request: { url: 'string' }, response: { data: 'unknown' } },
  'notify:show': { request: { title: 'string', body: 'string' }, response: { ok: 'boolean' } },
  'mcp:list-tools': { request: {}, response: { tools: 'unknown[]' } }
}

export type IpcRequestOf<C extends string> = C extends keyof typeof ipcChannelSchema
  ? (typeof ipcChannelSchema)[C]['request']
  : unknown
export type IpcResponseOf<C extends string> = C extends keyof typeof ipcChannelSchema
  ? (typeof ipcChannelSchema)[C]['response']
  : unknown
