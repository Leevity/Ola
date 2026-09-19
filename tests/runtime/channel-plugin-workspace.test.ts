import { describe, expect, it } from 'vitest'
import {
  authorizeChannelPluginWorkspace,
  authorizeChannelStreamWorkspace,
  channelPluginInWorkspace,
  loadAuthorizedChannelPlugin
} from '../../src/main/channels/channel-plugin-workspace'
import type { ChannelInstance } from '../../src/main/channels/channel-types'

const plugins: ChannelInstance[] = [
  {
    id: 'local-plugin',
    type: 'qq-bot',
    name: 'Local',
    enabled: true,
    config: {},
    createdAt: 1
  },
  {
    id: 'team-plugin',
    type: 'feishu-bot',
    name: 'Team',
    enabled: true,
    config: {},
    createdAt: 1,
    workspaceId: 'team-a'
  }
]

describe('channel plugin operation ownership', () => {
  it('treats legacy unbound channels as local only', () => {
    expect(channelPluginInWorkspace(plugins[0], 'local-personal')).toBe(true)
    expect(channelPluginInWorkspace(plugins[0], 'team-a')).toBe(false)
    expect(channelPluginInWorkspace(plugins[1], 'team-a')).toBe(true)
    expect(channelPluginInWorkspace(plugins[1], 'local-personal')).toBe(false)
  })
  it('requires persisted plugin ownership and a current offline team authorization', async () => {
    let available = new Set(['team-a'])
    const loadPlugins = async () => plugins
    const loadWorkspaceIds = async () => available
    await expect(
      authorizeChannelPluginWorkspace(
        'local-plugin',
        'local-personal',
        loadPlugins,
        loadWorkspaceIds
      )
    ).resolves.toBe('local-personal')
    await expect(
      authorizeChannelPluginWorkspace('team-plugin', 'team-a', loadPlugins, loadWorkspaceIds)
    ).resolves.toBe('team-a')
    await expect(
      loadAuthorizedChannelPlugin('team-plugin', 'team-a', loadPlugins, loadWorkspaceIds)
    ).resolves.toBe(plugins[1])
    await expect(
      authorizeChannelPluginWorkspace(
        'team-plugin',
        'local-personal',
        loadPlugins,
        loadWorkspaceIds
      )
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    available = new Set()
    await expect(
      authorizeChannelPluginWorkspace('team-plugin', undefined, loadPlugins, loadWorkspaceIds)
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    await expect(
      authorizeChannelPluginWorkspace('missing', 'team-a', loadPlugins, loadWorkspaceIds)
    ).rejects.toThrow('CHANNEL_PLUGIN_NOT_FOUND')
  })

  it('binds every streaming operation to the current plugin and original stream workspace', async () => {
    let available = new Set(['team-a'])
    const loadPlugins = async () => plugins
    const loadWorkspaceIds = async () => available
    await expect(
      authorizeChannelStreamWorkspace(
        'team-plugin',
        'team-a',
        undefined,
        loadPlugins,
        loadWorkspaceIds
      )
    ).resolves.toBe('team-a')
    await expect(
      authorizeChannelStreamWorkspace(
        'team-plugin',
        'team-a',
        'team-a',
        loadPlugins,
        loadWorkspaceIds
      )
    ).resolves.toBe('team-a')
    for (const [requestedWorkspaceId, streamWorkspaceId] of [
      ['local-personal', 'team-a'],
      ['team-a', 'local-personal'],
      [undefined, 'team-a']
    ] as const) {
      await expect(
        authorizeChannelStreamWorkspace(
          'team-plugin',
          requestedWorkspaceId,
          streamWorkspaceId,
          loadPlugins,
          loadWorkspaceIds
        )
      ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    }
    available = new Set()
    await expect(
      authorizeChannelStreamWorkspace(
        'team-plugin',
        'team-a',
        'team-a',
        loadPlugins,
        loadWorkspaceIds
      )
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
  })
})
