import { nanoid } from 'nanoid'
import { toolRegistry } from '../agent/tool-registry'
import type { DrawGraphProject } from '../../../../shared/draw-graph'
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
        target: { type: 'string' }
      },
      required: ['action']
    }
  },
  execute: async (input, context) => {
    const loaded = (await context.ipc.invoke('draw-graph:load', { id: 'default' })) as {
      project: DrawGraphProject
    }
    const project = loaded.project
    if (input.action === 'inspect') {
      return JSON.stringify({ id: project.id, nodes: project.nodes, edges: project.edges })
    }
    if (input.action === 'add_node') {
      const kind = input.kind === 'image' || input.kind === 'config' ? input.kind : 'text'
      const id = nanoid()
      project.nodes.push({
        id,
        kind,
        x: 100 + project.nodes.length * 24,
        y: 100 + project.nodes.length * 20,
        width: 220,
        height: 120,
        title: typeof input.title === 'string' ? input.title : `${kind} node`,
        content: typeof input.content === 'string' ? input.content : ''
      })
      await context.ipc.invoke('draw-graph:save', project)
      return JSON.stringify({ success: true, nodeId: id })
    }
    if (
      input.action === 'connect' &&
      typeof input.source === 'string' &&
      typeof input.target === 'string'
    ) {
      if (
        !project.nodes.some((node) => node.id === input.source) ||
        !project.nodes.some((node) => node.id === input.target)
      ) {
        return JSON.stringify({ success: false, error: 'Canvas node not found' })
      }
      project.edges.push({ id: nanoid(), source: input.source, target: input.target })
      await context.ipc.invoke('draw-graph:save', project)
      return JSON.stringify({ success: true })
    }
    return JSON.stringify({ success: false, error: 'Invalid canvas operation' })
  },
  requiresApproval: (input) => input.action !== 'inspect'
}

export function registerCanvasTool(): void {
  toolRegistry.register(canvasHandler)
}
