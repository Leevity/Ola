import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  createEmptyDrawGraphProject,
  wouldCreateDrawGraphCycle,
  type DrawGraphChangeRecord,
  type DrawGraphNodeKind,
  type DrawGraphProject
} from '../../../shared/draw-graph'

type ProjectUpdater = DrawGraphProject | ((current: DrawGraphProject) => DrawGraphProject)

export type CanvasAssistantAction =
  | { action: 'add_node'; kind?: DrawGraphNodeKind; title?: string; content?: string }
  | {
      action: 'update_node'
      nodeId: string
      patch: {
        title?: string
        content?: string
        x?: number
        y?: number
        width?: number
        height?: number
      }
    }
  | { action: 'delete_nodes'; nodeIds: string[] }
  | { action: 'connect'; source: string; target: string }
  | { action: 'disconnect'; edgeId?: string; source?: string; target?: string }

interface DrawGraphState {
  project: DrawGraphProject
  loadedProjectId: string | null
  setProject: (updater: ProjectUpdater) => void
  loadProject: (id: string) => Promise<DrawGraphProject>
  applyAssistantAction: (action: CanvasAssistantAction) => Promise<Record<string, unknown>>
}

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) || fallback : fallback
}

function appendChange(
  project: DrawGraphProject,
  action: DrawGraphChangeRecord['action'],
  summary: string,
  createdAt: number
): NonNullable<DrawGraphProject['changes']> {
  return [
    ...(project.changes ?? []).slice(-199),
    { id: nanoid(), source: 'assistant', action, summary, createdAt }
  ]
}

async function persist(project: DrawGraphProject): Promise<void> {
  await ipcClient.invoke('draw-graph:save', project)
}

let assistantMutationQueue = Promise.resolve()

async function acquireAssistantMutation(): Promise<() => void> {
  const previous = assistantMutationQueue
  let release!: () => void
  assistantMutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  return release
}

export const useDrawGraphStore = create<DrawGraphState>((set, get) => ({
  project: createEmptyDrawGraphProject(),
  loadedProjectId: null,
  setProject: (updater) =>
    set((state) => {
      const project = typeof updater === 'function' ? updater(state.project) : updater
      return { project, loadedProjectId: project.id }
    }),
  loadProject: async (id) => {
    if (get().loadedProjectId === id) return get().project
    const loaded = (await ipcClient.invoke('draw-graph:load', { id })) as {
      project: DrawGraphProject
    }
    set({ project: loaded.project, loadedProjectId: id })
    return loaded.project
  },
  applyAssistantAction: async (action) => {
    const release = await acquireAssistantMutation()
    try {
      const current = get().project
      const createdAt = Date.now()
      if (action.action === 'add_node') {
        const kind: DrawGraphNodeKind = ['image', 'text', 'config'].includes(action.kind ?? '')
          ? (action.kind as DrawGraphNodeKind)
          : 'text'
        const nodeId = nanoid()
        const title = boundedText(action.title, `${kind} node`, 500)
        const content = boundedText(action.content, '', 2_000_000)
        const next: DrawGraphProject = {
          ...current,
          updatedAt: createdAt,
          nodes: [
            ...current.nodes,
            {
              id: nodeId,
              kind,
              x: 100 + current.nodes.length * 24,
              y: 100 + current.nodes.length * 20,
              width: 220,
              height: 120,
              title,
              content
            }
          ],
          changes: appendChange(current, 'add_node', title, createdAt)
        }
        await persist(next)
        set({ project: next })
        return { success: true, nodeId }
      }

      if (action.action === 'update_node') {
        const node = current.nodes.find((item) => item.id === action.nodeId)
        if (!node) return { success: false, error: 'Canvas node not found' }
        const finite = (value: unknown, fallback: number, min: number, max: number): number =>
          typeof value === 'number' && Number.isFinite(value)
            ? Math.min(max, Math.max(min, value))
            : fallback
        const next: DrawGraphProject = {
          ...current,
          updatedAt: createdAt,
          nodes: current.nodes.map((item) =>
            item.id === action.nodeId
              ? {
                  ...item,
                  title: boundedText(action.patch.title, item.title, 500),
                  content: boundedText(action.patch.content, item.content, 2_000_000),
                  x: finite(action.patch.x, item.x, -100_000, 100_000),
                  y: finite(action.patch.y, item.y, -100_000, 100_000),
                  width: finite(action.patch.width, item.width, 80, 4_000),
                  height: finite(action.patch.height, item.height, 60, 4_000)
                }
              : item
          ),
          changes: appendChange(current, 'update_node', action.nodeId, createdAt)
        }
        await persist(next)
        set({ project: next })
        return { success: true, nodeId: action.nodeId }
      }

      if (action.action === 'delete_nodes') {
        const nodeIds = Array.from(new Set(action.nodeIds)).filter((id) =>
          current.nodes.some((node) => node.id === id)
        )
        if (nodeIds.length === 0) return { success: false, error: 'Canvas node not found' }
        const removed = new Set(nodeIds)
        const next: DrawGraphProject = {
          ...current,
          updatedAt: createdAt,
          nodes: current.nodes.filter((node) => !removed.has(node.id)),
          edges: current.edges.filter(
            (edge) => !removed.has(edge.source) && !removed.has(edge.target)
          ),
          changes: appendChange(current, 'delete_nodes', nodeIds.join(', '), createdAt)
        }
        await persist(next)
        set({ project: next })
        return { success: true, deletedNodeIds: nodeIds }
      }

      if (action.action === 'disconnect') {
        const removedEdges = current.edges.filter(
          (edge) =>
            (action.edgeId && edge.id === action.edgeId) ||
            (!action.edgeId && edge.source === action.source && edge.target === action.target)
        )
        if (removedEdges.length === 0)
          return { success: false, error: 'Canvas connection not found' }
        const removedIds = new Set(removedEdges.map((edge) => edge.id))
        const next: DrawGraphProject = {
          ...current,
          updatedAt: createdAt,
          edges: current.edges.filter((edge) => !removedIds.has(edge.id)),
          changes: appendChange(
            current,
            'disconnect',
            removedEdges.map((edge) => edge.id).join(', '),
            createdAt
          )
        }
        await persist(next)
        set({ project: next })
        return { success: true, deletedEdgeIds: Array.from(removedIds) }
      }

      if (
        action.source === action.target ||
        !current.nodes.some((node) => node.id === action.source) ||
        !current.nodes.some((node) => node.id === action.target) ||
        wouldCreateDrawGraphCycle(current.edges, action.source, action.target)
      ) {
        return { success: false, error: 'Canvas node not found or connection is invalid' }
      }
      if (
        current.edges.some((edge) => edge.source === action.source && edge.target === action.target)
      ) {
        return { success: true, unchanged: true }
      }
      const next: DrawGraphProject = {
        ...current,
        updatedAt: createdAt,
        edges: [...current.edges, { id: nanoid(), source: action.source, target: action.target }],
        changes: appendChange(current, 'connect', `${action.source} -> ${action.target}`, createdAt)
      }
      await persist(next)
      set({ project: next })
      return { success: true }
    } finally {
      release()
    }
  }
}))
