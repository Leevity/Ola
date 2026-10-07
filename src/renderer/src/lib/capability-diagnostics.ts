import type { ProviderHealth } from '../../../shared/provider-health'
import type { McpServerConfig, McpServerStatus } from './mcp/types'
import type { PluginInstance } from './channel/types'
import type { ExtensionInstance } from '../../../shared/extension-types'

export interface CapabilityDiagnosticInput {
  generatedAt: Date
  locale: string
  providerHealth: {
    loaded: boolean
    failed: boolean
    providers: ProviderHealth[]
  }
  skills: { loaded: boolean; failed: boolean; installedCount: number }
  builtinPlugins: {
    loaded: boolean
    total: number
    enabled: number
    needsSetup: number
  }
  extensions: { loaded: boolean; failed: boolean; items: ExtensionInstance[] }
  mcp: {
    loaded: boolean
    failed: boolean
    statusChecked: boolean
    statusCheckFailed: boolean
    servers: McpServerConfig[]
    statuses: Record<string, McpServerStatus>
  }
  channels: {
    loaded: boolean
    failed: boolean
    statusChecked: boolean
    statusCheckFailedCount: number
    items: PluginInstance[]
    statuses: Record<string, 'running' | 'stopped' | 'error'>
  }
}

/** Build a diagnostic export from allowlisted aggregate values only. Never pass raw config here. */
export function buildCapabilityDiagnosticSnapshot(input: CapabilityDiagnosticInput): object {
  const providerCounts = { healthy: 0, degraded: 0, unavailable: 0 }
  for (const provider of input.providerHealth.providers) {
    providerCounts[provider.status === 'down' ? 'unavailable' : provider.status] += 1
  }

  const enabledServers = input.mcp.servers.filter((server) => server.enabled)
  const mcpCounts = {
    enabled: enabledServers.length,
    connected: 0,
    connecting: 0,
    disconnected: 0,
    error: 0,
    unknown: 0
  }
  for (const server of enabledServers) {
    const status = input.mcp.statuses[server.id]
    if (status === 'connected') mcpCounts.connected += 1
    else if (status === 'connecting') mcpCounts.connecting += 1
    else if (status === 'disconnected') mcpCounts.disconnected += 1
    else if (status === 'error') mcpCounts.error += 1
    else mcpCounts.unknown += 1
  }

  const enabledChannels = input.channels.items.filter((channel) => channel.enabled)
  const channelCounts = {
    enabled: enabledChannels.length,
    running: 0,
    stopped: 0,
    error: 0,
    unknown: 0
  }

  const extensionCounts = {
    installed: input.extensions.items.length,
    enabled: input.extensions.items.filter((extension) => extension.enabled).length
  }
  for (const channel of enabledChannels) {
    const status = input.channels.statuses[channel.id]
    if (status === 'running') channelCounts.running += 1
    else if (status === 'stopped') channelCounts.stopped += 1
    else if (status === 'error') channelCounts.error += 1
    else channelCounts.unknown += 1
  }

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    locale: input.locale,
    redaction: {
      mode: 'aggregate_only',
      excluded: [
        'credentials and secrets',
        'provider, server, channel, extension, and skill names or identifiers',
        'commands, URLs, file paths, environment variables, and configuration values',
        'prompts, messages, tool arguments, and project or workspace identifiers',
        'raw error messages'
      ]
    },
    capabilities: {
      providers: {
        loaded: input.providerHealth.loaded,
        failed: input.providerHealth.failed,
        total: input.providerHealth.providers.length,
        ...providerCounts
      },
      skills: {
        loaded: input.skills.loaded,
        failed: input.skills.failed,
        installedCount: input.skills.installedCount
      },
      builtinPlugins: {
        loaded: input.builtinPlugins.loaded,
        total: input.builtinPlugins.total,
        enabled: input.builtinPlugins.enabled,
        needsSetup: input.builtinPlugins.needsSetup
      },
      extensions: {
        loaded: input.extensions.loaded,
        failed: input.extensions.failed,
        ...extensionCounts
      },
      mcp: {
        loaded: input.mcp.loaded,
        failed: input.mcp.failed,
        statusChecked: input.mcp.statusChecked,
        statusCheckFailed: input.mcp.statusCheckFailed,
        ...mcpCounts
      },
      channels: {
        loaded: input.channels.loaded,
        failed: input.channels.failed,
        statusChecked: input.channels.statusChecked,
        statusCheckFailedCount: input.channels.statusCheckFailedCount,
        ...channelCounts
      }
    }
  }
}
