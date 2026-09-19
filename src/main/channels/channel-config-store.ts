import type { ChannelInstance } from './channel-types'
import { ChannelConfigFileStore } from './channel-config-file-store'

const channelConfigStore = new ChannelConfigFileStore()

export async function readChannelPlugins(): Promise<ChannelInstance[]> {
  try {
    return await channelConfigStore.list()
  } catch (err) {
    console.error('[Channels] Config read error:', err)
    return []
  }
}

export async function writeChannelPlugins(plugins: ChannelInstance[]): Promise<void> {
  const result = await channelConfigStore.write(plugins)
  if (!result.success) {
    throw new Error(result.error ?? 'Channel config write failed')
  }
}

export async function getChannelPlugin(id: string): Promise<ChannelInstance | null> {
  return await channelConfigStore.get(id)
}

export async function isChannelPluginToolEnabled(
  pluginId: string,
  toolName: string
): Promise<boolean> {
  const plugin = await getChannelPlugin(pluginId)
  if (!plugin?.tools) return true
  return plugin.tools[toolName] !== false
}
