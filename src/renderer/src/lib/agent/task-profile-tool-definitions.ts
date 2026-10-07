import type { ToolDefinition } from '../api/types'
import type { TaskProfile } from '../task-profile'

export function withRequestTaskToolDefinition(
  definitions: ToolDefinition[],
  requestTaskDefinition: ToolDefinition
): ToolDefinition[] {
  if (!definitions.some((definition) => definition.name === requestTaskDefinition.name))
    return definitions
  return definitions.map((definition) =>
    definition.name === requestTaskDefinition.name ? requestTaskDefinition : definition
  )
}

export async function createRequestToolDefinitionSnapshot(input: {
  taskProfile: TaskProfile
  refreshCatalog: (taskProfile: TaskProfile) => Promise<void>
  getDefinitions: () => ToolDefinition[]
  getTaskDefinition: (taskProfile: TaskProfile) => ToolDefinition
}): Promise<ToolDefinition[]> {
  await input.refreshCatalog(input.taskProfile)
  return withRequestTaskToolDefinition(
    input.getDefinitions(),
    input.getTaskDefinition(input.taskProfile)
  )
}
