import type { IPCChannel } from './contract'

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
  'settings:set': { request: { key: 'string', value: 'unknown' }, response: { ok: 'boolean' } },
  'db:messages:list': { request: { sessionId: 'string', cursor: 'string | undefined' }, response: { messages: 'UnifiedMessage[]' } },
  'db:messages:update': { request: { messageId: 'string', patch: 'unknown' }, response: { ok: 'boolean' } },
  'remote:session:list': { request: { workspaceId: 'string' }, response: { sessions: 'Session[]' } },
  'fs:read-file': { request: { path: 'string' }, response: { content: 'string' } },
  'fs:write-file': { request: { path: 'string', content: 'string' }, response: { ok: 'boolean' } },
  'shell:exec': { request: { command: 'string', cwd: 'string | undefined' }, response: { output: 'string' } },
  'shell:abort': { request: { runId: 'string' }, response: { ok: 'boolean' } },
  'browser:execute-script': { request: { target: 'unknown', script: 'string' }, response: { result: 'unknown' } },
  'credentials:store': { request: { credentialId: 'string', secret: 'string' }, response: { ok: 'boolean' } },
  'credentials:fill-password': { request: { credentialId: 'string', target: 'string' }, response: { ok: 'boolean' } },
  'git:get-status': { request: { workspaceId: 'string' }, response: { status: 'unknown' } },
  'image:download': { request: { url: 'string' }, response: { data: 'unknown' } },
  'notify:session': { request: { title: 'string', body: 'string' }, response: { ok: 'boolean' } },
  'mcp:list-tools': { request: {}, response: { tools: 'unknown[]' } }
}

export type IpcRequestOf<C extends string> = C extends keyof typeof ipcChannelSchema
  ? (typeof ipcChannelSchema)[C]['request']
  : unknown
export type IpcResponseOf<C extends string> = C extends keyof typeof ipcChannelSchema
  ? (typeof ipcChannelSchema)[C]['response']
  : unknown
