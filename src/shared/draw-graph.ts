export const DRAW_GRAPH_SCHEMA_VERSION = 1
export const DRAW_GRAPH_MAX_NODES = 5_000
export const DRAW_GRAPH_MAX_EDGES = 10_000

export type DrawGraphNodeKind = 'image' | 'video' | 'text' | 'config'
export interface DrawGraphAssetRef {
  id: string
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  maskAssetId?: string
}
export type DrawGraphOperationState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DrawGraphImageOperation {
  id: string
  type: 'crop' | 'mask' | 'expand' | 'outpaint' | 'upscale' | 'angle'
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
  asset?: DrawGraphAssetRef
  trigger?: {
    enabled: boolean
    action: 'outpaint' | 'upscale' | 'generate_video'
    lastRunKey?: string
    lastTriggeredAt?: number
  }
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

export interface DrawGraphChangeRecord {
  id: string
  source: 'assistant'
  action: 'add_node' | 'update_node' | 'delete_nodes' | 'connect' | 'disconnect'
  summary: string
  createdAt: number
}

export interface DrawGraphProject {
  version: typeof DRAW_GRAPH_SCHEMA_VERSION
  id: string
  name: string
  updatedAt: number
  nodes: DrawGraphNode[]
  edges: DrawGraphEdge[]
  changes?: DrawGraphChangeRecord[]
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

export function wouldCreateDrawGraphCycle(
  edges: DrawGraphEdge[],
  source: string,
  target: string
): boolean {
  if (source === target) return true
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
  }
  const pending = [target]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const nodeId = pending.pop()!
    if (nodeId === source) return true
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    pending.push(...(outgoing.get(nodeId) ?? []))
  }
  return false
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function hasSafeParameters(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= 100 &&
    entries.every(
      ([key, item]) =>
        key.length <= 128 &&
        (typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)) ||
          isBoundedString(item, 20_000))
    )
  )
}

export function isValidDrawGraphProject(value: unknown): value is DrawGraphProject {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<DrawGraphProject>
  if (
    project.version !== DRAW_GRAPH_SCHEMA_VERSION ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(project.id ?? '') ||
    !isBoundedString(project.name, 500) ||
    !Number.isFinite(project.updatedAt) ||
    !Array.isArray(project.nodes) ||
    !Array.isArray(project.edges) ||
    (project.changes !== undefined &&
      (!Array.isArray(project.changes) || project.changes.length > 1_000)) ||
    project.nodes.length > DRAW_GRAPH_MAX_NODES ||
    project.edges.length > DRAW_GRAPH_MAX_EDGES
  )
    return false

  if (
    project.changes?.some(
      (change) =>
        !change ||
        !isBoundedString(change.id, 128) ||
        change.source !== 'assistant' ||
        !['add_node', 'update_node', 'delete_nodes', 'connect', 'disconnect'].includes(
          change.action
        ) ||
        !isBoundedString(change.summary, 2_000) ||
        !Number.isFinite(change.createdAt)
    )
  )
    return false

  const nodeIds = new Set<string>()
  for (const node of project.nodes) {
    if (
      !node ||
      !isBoundedString(node.id, 128) ||
      !node.id ||
      nodeIds.has(node.id) ||
      !['image', 'video', 'text', 'config'].includes(node.kind) ||
      ![node.x, node.y, node.width, node.height].every(Number.isFinite) ||
      node.width <= 0 ||
      node.height <= 0 ||
      !isBoundedString(node.title, 500) ||
      !isBoundedString(node.content, 2_000_000) ||
      (node.error !== undefined && !isBoundedString(node.error, 20_000)) ||
      (node.trigger !== undefined &&
        (!node.trigger ||
          typeof node.trigger.enabled !== 'boolean' ||
          !['outpaint', 'upscale', 'generate_video'].includes(node.trigger.action) ||
          (node.trigger.lastRunKey !== undefined &&
            !isBoundedString(node.trigger.lastRunKey, 2_000)) ||
          (node.trigger.lastTriggeredAt !== undefined &&
            !Number.isFinite(node.trigger.lastTriggeredAt)))) ||
      (node.asset !== undefined &&
        (!node.asset ||
          !/^[a-f0-9-]{36}\.(png|jpg)$/.test(node.asset.id) ||
          !['image/png', 'image/jpeg'].includes(node.asset.mediaType) ||
          !Number.isInteger(node.asset.width) ||
          !Number.isInteger(node.asset.height) ||
          node.asset.width <= 0 ||
          node.asset.height <= 0 ||
          node.asset.width > 16_384 ||
          node.asset.height > 16_384 ||
          (node.asset.maskAssetId !== undefined &&
            !/^[a-f0-9-]{36}\.png$/.test(node.asset.maskAssetId)))) ||
      (node.imageOperations !== undefined &&
        (!Array.isArray(node.imageOperations) ||
          node.imageOperations.length > 100 ||
          node.imageOperations.some(
            (operation) =>
              !operation ||
              !isBoundedString(operation.id, 128) ||
              !['crop', 'mask', 'expand', 'outpaint', 'upscale', 'angle'].includes(
                operation.type
              ) ||
              !Number.isFinite(operation.value) ||
              !hasSafeParameters(operation.parameters) ||
              (operation.error !== undefined && !isBoundedString(operation.error, 20_000))
          ))) ||
      (node.video !== undefined &&
        (!node.video ||
          Object.values(node.video).some(
            (item) => typeof item === 'string' && item.length > 2_000_000
          )))
    )
      return false
    nodeIds.add(node.id)
  }

  const edgeIds = new Set<string>()
  return project.edges.every((edge) => {
    if (
      !edge ||
      !isBoundedString(edge.id, 128) ||
      !edge.id ||
      edgeIds.has(edge.id) ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target)
    )
      return false
    edgeIds.add(edge.id)
    return true
  })
}
