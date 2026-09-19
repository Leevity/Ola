import type { ChannelInstance } from './channel-types'
import { authorizeChannelSessionWorkspace } from './channel-session-workspace'

export function channelPluginInWorkspace(plugin: ChannelInstance, workspaceId: string): boolean {
  return (plugin.workspaceId || 'local-personal') === workspaceId
}

export async function authorizeChannelPluginWorkspace(
  pluginId: unknown,
  requestedWorkspaceId: unknown,
  loadPlugins: () => Promise<ChannelInstance[]>,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  const plugin = await loadAuthorizedChannelPlugin(
    pluginId,
    requestedWorkspaceId,
    loadPlugins,
    availableWorkspaceIds
  )
  return plugin.workspaceId || 'local-personal'
}

export async function authorizeChannelStreamWorkspace(
  pluginId: unknown,
  requestedWorkspaceId: unknown,
  streamWorkspaceId: string | undefined,
  loadPlugins: () => Promise<ChannelInstance[]>,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  if (typeof requestedWorkspaceId !== 'string') throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
  const workspaceId = await authorizeChannelPluginWorkspace(
    pluginId,
    requestedWorkspaceId,
    loadPlugins,
    availableWorkspaceIds
  )
  if (streamWorkspaceId !== undefined && streamWorkspaceId !== workspaceId)
    throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
  return workspaceId
}

export async function loadAuthorizedChannelPlugin(
  pluginId: unknown,
  requestedWorkspaceId: unknown,
  loadPlugins: () => Promise<ChannelInstance[]>,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<ChannelInstance> {
  if (typeof pluginId !== 'string' || !pluginId || pluginId !== pluginId.trim())
    throw new Error('CHANNEL_PLUGIN_NOT_FOUND')
  const plugin = (await loadPlugins()).find((candidate) => candidate.id === pluginId)
  if (!plugin) throw new Error('CHANNEL_PLUGIN_NOT_FOUND')
  const workspaceId = await authorizeChannelSessionWorkspace(
    plugin.workspaceId,
    availableWorkspaceIds
  )
  if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== workspaceId)
    throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
  return plugin
}
