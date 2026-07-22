import { toolRegistry } from '../agent/tool-registry'
import { agentBridge } from '../ipc/agent-bridge'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

const handler: ToolHandler = {
  definition: {
    name: 'codegraph_explore',
    description:
      'Explore the indexed code graph for related definitions, references, callers and files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or code-structure question.' },
        projectPath: { type: 'string', description: 'Optional absolute project root.' }
      },
      required: ['query']
    }
  },
  execute: async (input, context) => {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return encodeStructuredToolResult({ error: 'query is required' })
    const projectPath =
      typeof input.projectPath === 'string' && input.projectPath.trim()
        ? input.projectPath.trim()
        : context.workingFolder
    try {
      const args = {
        query,
        ...(projectPath ? { workingFolder: projectPath } : {})
      }
      let result = await agentBridge.requestCodeGraph('codegraph/explore', args)
      if (
        projectPath &&
        result &&
        typeof result === 'object' &&
        (result as { errorKind?: unknown }).errorKind === 'not_indexed'
      ) {
        const indexed = await agentBridge.requestCodeGraph(
          'codegraph/index',
          {
            workingFolder: projectPath
          },
          300_000
        )
        if (
          indexed &&
          typeof indexed === 'object' &&
          (indexed as { success?: unknown }).success === true
        ) {
          result = await agentBridge.requestCodeGraph('codegraph/explore', args)
        } else {
          result = indexed
        }
      }
      return encodeStructuredToolResult(
        result && typeof result === 'object' ? (result as Record<string, unknown>) : { result }
      )
    } catch (error) {
      return encodeStructuredToolResult({
        error: error instanceof Error ? error.message : String(error)
      })
    }
  },
  requiresApproval: () => false
}

let registered = false

export function registerCodeGraphTool(): void {
  if (registered) return
  toolRegistry.register(handler)
  registered = true
}

export function unregisterCodeGraphTool(): void {
  if (!registered) return
  toolRegistry.unregister(handler.definition.name)
  registered = false
}
