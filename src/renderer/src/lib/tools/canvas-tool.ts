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
        action: {
          type: 'string',
          enum: ['inspect', 'add_node', 'update_node', 'delete_nodes', 'connect', 'disconnect']
        },
        kind: { type: 'string', enum: ['image', 'text', 'config'] },
        title: { type: 'string' },
        content: { type: 'string' },
        source: { type: 'string' },
        target: { type: 'string' },
        nodeId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' } },
        edgeId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
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
    if (input.action === 'update_node' && typeof input.nodeId === 'string') {
      return JSON.stringify(
        await useDrawGraphStore.getState().applyAssistantAction({
          action: 'update_node',
          nodeId: input.nodeId,
          patch: {
            ...(typeof input.title === 'string' ? { title: input.title } : {}),
            ...(typeof input.content === 'string' ? { content: input.content } : {}),
            ...(typeof input.x === 'number' ? { x: input.x } : {}),
            ...(typeof input.y === 'number' ? { y: input.y } : {}),
            ...(typeof input.width === 'number' ? { width: input.width } : {}),
            ...(typeof input.height === 'number' ? { height: input.height } : {})
          }
        })
      )
    }
    if (input.action === 'delete_nodes' && Array.isArray(input.nodeIds)) {
      return JSON.stringify(
        await useDrawGraphStore.getState().applyAssistantAction({
          action: 'delete_nodes',
          nodeIds: input.nodeIds.filter((id): id is string => typeof id === 'string')
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
    if (input.action === 'disconnect') {
      return JSON.stringify(
        await useDrawGraphStore.getState().applyAssistantAction({
          action: 'disconnect',
          ...(typeof input.edgeId === 'string' ? { edgeId: input.edgeId } : {}),
          ...(typeof input.source === 'string' ? { source: input.source } : {}),
          ...(typeof input.target === 'string' ? { target: input.target } : {})
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
