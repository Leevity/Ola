import { registerTaskTools } from './todo-tool'
import { registerFsTools } from './fs-tool'
import { registerSearchTools } from './search-tool'
import {
  registerWebSearchTool,
  unregisterWebSearchTool,
  isWebSearchToolRegistered
} from './web-search-tool'
import { registerBashTools } from './bash-tool'
import { registerTeamTools } from '../agent/teams/register'
import { registerWidgetTools } from './widget-tool'
import { registerAskUserTools } from './ask-user-tool'
import { registerPlanTools } from './plan-tool'
import { registerCronTools } from './cron-tool'
import { registerNotifyTool } from './notify-tool'
import { registerGoalTools } from './goal-tool'
import { registerMemoryTools } from './memory-tool'
import { refreshDynamicToolCatalog } from './dynamic-tool-catalog'
import { registerCodeCompatibleTools } from './code-compatible-tool'
import { isCanvasToolRegistered, registerCanvasTool, unregisterCanvasTool } from './canvas-tool'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  isVideoGenerationToolRegistered,
  registerVideoGenerationTool,
  unregisterVideoGenerationTool
} from './video-generation-tool'

let staticToolsRegistered = false
let dynamicToolsReady = false
let registrationPromise: Promise<void> | null = null

export function registerAllTools(): Promise<void> {
  if (!staticToolsRegistered) {
    registerTaskTools()
    registerFsTools()
    registerSearchTools()
    // Note: WebSearchTool is NOT registered here — it's registered/unregistered dynamically
    // based on the webSearchEnabled setting (see web-search-tool.ts)
    registerBashTools()
    registerWidgetTools()
    registerAskUserTools()
    registerPlanTools()
    registerCronTools()
    registerNotifyTool()
    registerGoalTools()
    registerMemoryTools()
    updateCanvasToolRegistration(useSettingsStore.getState().advancedDrawEnabled)
    updateVideoGenerationToolRegistration(useSettingsStore.getState().videoGenerationEnabled)

    // These tools must remain available when a user-editable catalog fails to load.
    registerCodeCompatibleTools()
    registerTeamTools()
    staticToolsRegistered = true
  }

  if (dynamicToolsReady) return Promise.resolve()
  if (registrationPromise) return registrationPromise

  // Skills and SubAgents are user-editable catalogs; load them once here and
  // refresh them again before every request via ensureRequestToolCatalogFresh().
  registrationPromise = refreshDynamicToolCatalog()
    .then(() => {
      dynamicToolsReady = true
    })
    .finally(() => {
      registrationPromise = null
    })

  // Plugin tools are registered/unregistered dynamically via channel-store toggle
  // They are NOT registered here — see plugin-tools.ts registerPluginTools/unregisterPluginTools
  return registrationPromise
}

export function updateWebSearchToolRegistration(enabled: boolean): void {
  const isRegistered = isWebSearchToolRegistered()
  if (enabled && !isRegistered) {
    registerWebSearchTool()
  } else if (!enabled && isRegistered) {
    unregisterWebSearchTool()
  }
}

export function updateCanvasToolRegistration(enabled: boolean): void {
  const isRegistered = isCanvasToolRegistered()
  if (enabled && !isRegistered) {
    registerCanvasTool()
  } else if (!enabled && isRegistered) {
    unregisterCanvasTool()
  }
}

export function updateVideoGenerationToolRegistration(enabled: boolean): void {
  const isRegistered = isVideoGenerationToolRegistered()
  if (enabled && !isRegistered) {
    registerVideoGenerationTool()
  } else if (!enabled && isRegistered) {
    unregisterVideoGenerationTool()
  }
}

export { ensureRequestToolCatalogFresh, refreshDynamicToolCatalog } from './dynamic-tool-catalog'
