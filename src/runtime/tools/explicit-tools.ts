import type { ToolDefinition } from './tool-executor'

/**
 * A run may only expose tools captured at submission time. This prevents a
 * later project, MCP, or extension change from changing an active run's
 * authority, and makes an absent snapshot capability-free by default.
 */
export function selectExplicitTools(
  definitions: readonly ToolDefinition[],
  toolNames: readonly string[] | undefined
): ToolDefinition[] {
  if (!toolNames?.length) return []
  const requested = new Set(toolNames)
  return definitions.filter((tool) => requested.has(tool.name))
}
