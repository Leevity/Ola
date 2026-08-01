export const DRAW_GRAPH_SCHEMA_VERSION = 1

export type DrawGraphNodeKind = 'image' | 'video' | 'text' | 'config'
export type DrawGraphOperationState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DrawGraphImageOperation {
  id: string
  type: 'crop' | 'mask' | 'expand' | 'upscale'
  value: number
  state?: DrawGraphOperationState
  parameters?: Record<string, string | number | boolean>
  outputAssetId?: string
  error?: string
}

export interface DrawGraphNode {
  id: string
  kind: DrawGraphNodeKind
  x: number
  y: number
  width: number
  height: number
  title: string
  content: string
  imageOperations?: DrawGraphImageOperation[]
  status?: DrawGraphOperationState
  outputAssetId?: string
  error?: string
  video?: {
    providerId?: string
    model?: string
    aspectRatio?: string
    durationSeconds?: number
    resolution?: string
    taskId?: string
    outputUrl?: string
  }
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
