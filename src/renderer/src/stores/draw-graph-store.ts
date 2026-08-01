import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  createEmptyDrawGraphProject,
  type DrawGraphNodeKind,
  type DrawGraphProject
} from '../../../shared/draw-graph'

type ProjectUpdater = DrawGraphProject | ((current: DrawGraphProject) => DrawGraphProject)

export type CanvasAssistantAction =
  | { action: 'add_node'; kind?: DrawGraphNodeKind; title?: string; content?: string }
  | { action: 'connect'; source: string; target: string }

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
        changes: [
          ...(current.changes ?? []).slice(-199),
          { id: nanoid(), source: 'assistant', action: 'add_node', summary: title, createdAt }
        ]
      }
      set({ project: next })
      await ipcClient.invoke('draw-graph:save', next)
      return { success: true, nodeId }
    }

    if (
      action.source === action.target ||
      !current.nodes.some((node) => node.id === action.source) ||
      !current.nodes.some((node) => node.id === action.target)
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
      changes: [
        ...(current.changes ?? []).slice(-199),
        {
          id: nanoid(),
          source: 'assistant',
          action: 'connect',
          summary: `${action.source} -> ${action.target}`,
          createdAt
        }
      ]
    }
    set({ project: next })
    await ipcClient.invoke('draw-graph:save', next)
    return { success: true }
  }
}))
