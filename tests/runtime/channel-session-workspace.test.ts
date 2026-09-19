import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeChannelSessionWorkspace,
  readAuthorizedChannelSession,
  runAuthorizedChannelCommand
} from '../../src/main/channels/channel-session-workspace'
import { ipcClient } from '../../src/renderer/src/lib/ipc/ipc-client'
import { useWorkspaceStore } from '../../src/renderer/src/stores/workspace-store'
import { isCurrentChannelSessionResponse } from '../../src/renderer/src/lib/channel-session-cache'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'

afterEach(() => {
  vi.unstubAllGlobals()
  useWorkspaceStore.setState({ activeWorkspaceId: 'local-personal' })
})

describe('channel session workspace authorization', () => {
  it('keeps local personal offline and requires a current directory grant for managed spaces', async () => {
    const directory = vi.fn(async () => new Set(['team-a']))
    await expect(authorizeChannelSessionWorkspace(undefined, directory)).resolves.toBe(
      'local-personal'
    )
    expect(directory).not.toHaveBeenCalled()
    await expect(authorizeChannelSessionWorkspace('team-a', directory)).resolves.toBe('team-a')
    await expect(authorizeChannelSessionWorkspace('team-b', directory)).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    await expect(authorizeChannelSessionWorkspace(' team-a', directory)).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
  })

  it('does not return a completed read after the team grant is revoked in flight', async () => {
    let granted = true
    let release!: (value: string[]) => void
    const directory = async () => new Set(granted ? ['team-a'] : [])
    const read = readAuthorizedChannelSession(
      'team-a',
      directory,
      () => new Promise<string[]>((resolve) => (release = resolve))
    )
    await expect.poll(() => release).toBeTypeOf('function')
    granted = false
    release(['private message'])
    await expect(read).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    await expect(
      readAuthorizedChannelSession('team-a', directory, async () => ['private message'])
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    await expect(
      readAuthorizedChannelSession('local-personal', directory, async () => ['local message'])
    ).resolves.toEqual(['local message'])
  })

  it('rechecks team authorization before command work and before exposing its result', async () => {
    let granted = true
    let release!: (value: string) => void
    const directory = async () => new Set(granted ? ['team-a'] : [])
    const run = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
    const command = runAuthorizedChannelCommand('team-a', directory, run)
    await expect.poll(() => release).toBeTypeOf('function')
    granted = false
    release('private status')
    await expect(command).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    await expect(runAuthorizedChannelCommand('team-a', directory, run)).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    expect(run).toHaveBeenCalledTimes(1)
    await expect(
      runAuthorizedChannelCommand('local-personal', directory, async () => 'local status')
    ).resolves.toBe('local status')
  })

  it('uses the active renderer workspace for every channel-session IPC shape', async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    vi.stubGlobal('window', {
      ola: {
        ipc: {
          invoke: async (channel: string, bytes: Uint8Array) => {
            sent.push({ channel, payload: decodeMessagePackPayload(bytes) })
            return encodeMessagePackPayload([])
          }
        }
      }
    })
    useWorkspaceStore.setState({ activeWorkspaceId: 'team-a' })
    await ipcClient.invoke('plugin:sessions:list', 'plugin-a')
    await ipcClient.invoke('plugin:sessions:find-by-chat', 'chat-a')
    await ipcClient.invoke('plugin:sessions:list-all')
    await ipcClient.invoke('plugin:sessions:messages', {
      sessionId: 'session-a',
      workspaceId: 'forged-team'
    })
    expect(sent.map(({ payload }) => payload)).toEqual([
      { pluginId: 'plugin-a', workspaceId: 'team-a' },
      { externalChatId: 'chat-a', workspaceId: 'team-a' },
      { workspaceId: 'team-a' },
      { sessionId: 'session-a', workspaceId: 'team-a' }
    ])
    expect(sent.every(({ channel }) => channel.endsWith(':msgpack'))).toBe(true)
  })

  it('rejects an old channel-session response after a workspace switch', () => {
    expect(isCurrentChannelSessionResponse('team-a', 'team-a')).toBe(true)
    expect(isCurrentChannelSessionResponse('team-a', 'team-b')).toBe(false)
  })
})
