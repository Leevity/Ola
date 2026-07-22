export const DRAW_GRAPH_SCHEMA_VERSION = 1

export type DrawGraphNodeKind = 'image' | 'text' | 'config'

export interface DrawGraphNode {
  id: string
  kind: DrawGraphNodeKind
  x: number
  y: number
  width: number
  height: number
  title: string
  content: string
}

export interface DrawGraphEdge {
  id: string
  source: string
  target: string
}

export interface DrawGraphProject {
  version: typeof DRAW_GRAPH_SCHEMA_VERSION
  id: string
  name: string
  updatedAt: number
  nodes: DrawGraphNode[]
  edges: DrawGraphEdge[]
}

export function createEmptyDrawGraphProject(id = 'default'): DrawGraphProject {
  return {
    version: DRAW_GRAPH_SCHEMA_VERSION,
    id,
    name: 'Ola Canvas',
    updatedAt: Date.now(),
    nodes: [],
    edges: []
  }
}
