import { createTaskTool } from '../create-tool'
import { toolRegistry } from '../../tool-registry'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { ProviderConfig } from '../../../api/types'
import { refreshSubAgentRegistry } from '../catalog'
import type { TaskProfile } from '../../../task-profile'

const TASK_TOOL_REGISTRY_NAME = 'Task'
let registeredTaskProfile: TaskProfile | null = null

function getProviderConfig(): ProviderConfig {
  const s = useSettingsStore.getState()
  const store = useProviderStore.getState()
  const fastConfig = store.getFastProviderConfig()
  if (fastConfig && (fastConfig.apiKey || fastConfig.requiresApiKey === false)) {
    return {
      ...fastConfig,
      maxTokens: store.getEffectiveMaxTokens(s.maxTokens, fastConfig.model),
      temperature: s.temperature
    }
  }
  const fallbackModel = s.model
  return {
    type: s.provider,
    apiKey: s.apiKey,
    baseUrl: s.baseUrl || undefined,
    model: fallbackModel,
    maxTokens: store.getEffectiveMaxTokens(s.maxTokens, fallbackModel),
    temperature: s.temperature
  }
}

/**
 * Load all agent .md files from ~/.ola/agents/ via IPC,
 * register them in the SubAgent registry, then register one unified
 * "Task" tool in the tool registry.
 *
 * This is async because it reads files via IPC from the main process.
 */
export async function refreshSubAgentTools(taskProfile: TaskProfile = 'work'): Promise<void> {
  const refreshStatus = await refreshSubAgentRegistry()
  if (refreshStatus === 'failed' && toolRegistry.has(TASK_TOOL_REGISTRY_NAME)) {
    return
  }
  if (
    refreshStatus === 'unchanged' &&
    toolRegistry.has(TASK_TOOL_REGISTRY_NAME) &&
    registeredTaskProfile === taskProfile
  ) {
    return
  }

  // Register one unified Task tool that dispatches by subagent_type
  // (works even if no agents were loaded — will produce an empty enum)
  toolRegistry.register(createTaskTool(getProviderConfig, taskProfile))
  registeredTaskProfile = taskProfile
}

/** Build the Task schema for one request without mutating the shared registry. */
export function createRequestTaskToolDefinition(taskProfile: TaskProfile) {
  return createTaskTool(getProviderConfig, taskProfile).definition
}

export async function registerSubAgents(taskProfile: TaskProfile = 'work'): Promise<void> {
  await refreshSubAgentTools(taskProfile)
}
