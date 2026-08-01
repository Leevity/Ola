import { toolRegistry } from '../agent/tool-registry'
import { useDrawGraphStore } from '../../stores/draw-graph-store'
import type { ToolHandler } from './tool-types'

const canvasHandler: ToolHandler = {
  definition: {
    name: 'CanvasOperation',
    description:
      'Inspect or update the current Ola node canvas. Supports adding nodes and connecting them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'add_node', 'connect'] },
        kind: { type: 'string', enum: ['image', 'text', 'config'] },
        title: { type: 'string' },
        content: { type: 'string' },
        source: { type: 'string' },
        target: { type: 'string' },
        projectId: { type: 'string' }
      },
      required: ['action']
    }
  },
  execute: async (input) => {
    const currentStore = useDrawGraphStore.getState()
    const projectId =
      typeof input.projectId === 'string'
        ? input.projectId
        : (currentStore.loadedProjectId ?? currentStore.project.id)
    const project = await useDrawGraphStore.getState().loadProject(projectId)
    if (input.action === 'inspect') {
      return JSON.stringify({ id: project.id, nodes: project.nodes, edges: project.edges })
    }
    if (input.action === 'add_node') {
      return JSON.stringify(
        await useDrawGraphStore.getState().applyAssistantAction({
          action: 'add_node',
          kind:
            input.kind === 'image' || input.kind === 'text' || input.kind === 'config'
              ? input.kind
              : undefined,
          title: typeof input.title === 'string' ? input.title : undefined,
          content: typeof input.content === 'string' ? input.content : undefined
        })
      )
    }
    if (
      input.action === 'connect' &&
      typeof input.source === 'string' &&
      typeof input.target === 'string'
    ) {
      return JSON.stringify(
        await useDrawGraphStore.getState().applyAssistantAction({
          action: 'connect',
          source: input.source,
          target: input.target
        })
      )
    }
    return JSON.stringify({ success: false, error: 'Invalid canvas operation' })
  },
  requiresApproval: (input) => input.action !== 'inspect'
}

export function registerCanvasTool(): void {
  toolRegistry.register(canvasHandler)
}

export function unregisterCanvasTool(): void {
  toolRegistry.unregister(canvasHandler.definition.name)
}

export function isCanvasToolRegistered(): boolean {
  return toolRegistry.has(canvasHandler.definition.name)
}
