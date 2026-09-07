import { refreshSubAgentTools } from '../agent/sub-agents/builtin'
import { refreshExtensionTools } from '../extensions/extension-tools'
import { refreshSkillTools } from './skill-tool'
import type { TaskProfile } from '../task-profile'

let refreshPromise: Promise<void> | null = null

async function runDynamicToolCatalogRefresh(taskProfile: TaskProfile): Promise<void> {
  await refreshSkillTools()
  await refreshSubAgentTools(taskProfile)
  await refreshExtensionTools()
}

export function refreshDynamicToolCatalog(taskProfile: TaskProfile = 'work'): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = runDynamicToolCatalogRefresh(taskProfile).finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

export const ensureRequestToolCatalogFresh = refreshDynamicToolCatalog
