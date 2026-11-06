// Regression for the MCP settings write path.
//
// Main validates the exposure policy and writes the config file atomically, and answers
// `{ success: false, error }` when either fails. The store used to merge the edit into local state
// regardless, so the panel kept showing a server that was never persisted and the refusal was
// invisible. `refreshServerInfo` had the mirror-image gap: an unknown server answered `undefined`
// and the previously advertised capabilities stayed on screen.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The MCP store reaches into the chat store for per-project activation only; the real module pulls
// the agent history migration, which needs a browser globals this node-environment test has none of.
vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  useChatStore: { getState: () => ({ sessions: [] }), setState: vi.fn() }
}))

import { ipcClient } from '../../src/renderer/src/lib/ipc/ipc-client'
import { IPC } from '../../src/renderer/src/lib/ipc/channels'
import { useMcpStore } from '../../src/renderer/src/stores/mcp-store'

const server = {
  id: 'server-1',
  name: 'Docs',
  enabled: true,
  transport: 'stdio' as const,
  createdAt: 1
}

describe('mcp store write outcomes', () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [{ ...server, toolAlias: 'docs' }],
      serversLoaded: true,
      serverStatuses: { 'server-1': 'connected' },
      serverTools: { 'server-1': [{ name: 'search' }] },
      serverExposedTools: { 'server-1': [] },
      serverResources: { 'server-1': [{ uri: 'file:///a', name: 'a' }] },
      serverPrompts: { 'server-1': [] },
      serverTruncated: { 'server-1': true },
      serverErrors: {}
    })
  })

  it('does not add a server Main refused to persist', async () => {
    const invoke = vi
      .spyOn(ipcClient, 'invoke')
      .mockResolvedValue({ success: false, error: 'MCP exposure cap exceeded' })
    await expect(
      useMcpStore.getState().addServer({
        name: 'Extra',
        enabled: true,
        transport: 'stdio'
      })
    ).rejects.toThrow('MCP exposure cap exceeded')
    expect(invoke).toHaveBeenCalled()
    expect(useMcpStore.getState().servers).toHaveLength(1)
  })

  it('keeps the stored config and reports the reason when an update is refused', async () => {
    vi.spyOn(ipcClient, 'invoke').mockResolvedValue({ success: false, error: 'Server not found' })
    await useMcpStore.getState().updateServer('server-1', { enabled: false })
    const state = useMcpStore.getState()
    expect(state.servers[0].enabled).toBe(true)
    expect(state.serverErrors['server-1']).toBe('Server not found')
  })

  it('applies an accepted update and clears the previous refusal', async () => {
    useMcpStore.setState({ serverErrors: { 'server-1': 'Server not found' } })
    vi.spyOn(ipcClient, 'invoke').mockResolvedValue({ success: true })
    await useMcpStore.getState().updateServer('server-1', { enabled: false })
    const state = useMcpStore.getState()
    expect(state.servers[0].enabled).toBe(false)
    expect(state.serverErrors['server-1']).toBeUndefined()
  })

  it('drops capabilities Main no longer reports', async () => {
    vi.spyOn(ipcClient, 'invoke').mockResolvedValue(undefined)
    await useMcpStore.getState().refreshServerInfo('server-1')
    const state = useMcpStore.getState()
    expect(state.serverTools['server-1']).toEqual([])
    expect(state.serverResources['server-1']).toEqual([])
    expect(state.serverStatuses['server-1']).toBe('disconnected')
    expect(state.serverTruncated['server-1']).toBe(false)
  })

  it('carries the truncation flag so a partial catalog can be labelled', async () => {
    vi.spyOn(ipcClient, 'invoke').mockResolvedValue({
      status: 'connected',
      config: { id: 'server-1' },
      tools: [{ name: 'search' }],
      exposedTools: [],
      exposure: {},
      resources: [],
      prompts: [],
      capabilitiesTruncated: true
    })
    await useMcpStore.getState().refreshServerInfo('server-1')
    expect(useMcpStore.getState().serverTruncated['server-1']).toBe(true)
  })

  it('removes a server only when Main confirms the write', async () => {
    const rejected = vi
      .spyOn(ipcClient, 'invoke')
      .mockResolvedValue({ success: false, error: 'config file is read-only' })
    await useMcpStore.getState().removeServer('server-1')
    expect(rejected).toHaveBeenCalledWith(IPC.MCP_REMOVE, 'server-1')
    expect(useMcpStore.getState().servers).toHaveLength(1)
    expect(useMcpStore.getState().serverErrors['server-1']).toBe('config file is read-only')
  })
})
