import type { DrawGraphNode, DrawGraphProject } from './draw-graph'

export interface DrawGraphTriggerRun {
  nodeId: string
  action: NonNullable<DrawGraphNode['trigger']>['action']
  runKey: string
}

function completedOutputKey(node: DrawGraphNode): string | null {
  if (node.status !== 'completed') return null
  const output = node.outputAssetId ?? node.asset?.id ?? node.video?.taskId
  return output ? `${node.id}:${output}` : null
}

export function resolveReadyDrawGraphTriggers(project: DrawGraphProject): DrawGraphTriggerRun[] {
  const nodes = new Map(project.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, DrawGraphNode[]>()
  for (const edge of project.edges) {
    const source = nodes.get(edge.source)
    if (!source) continue
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), source])
  }

  const runs: DrawGraphTriggerRun[] = []
  for (const node of project.nodes) {
    if (!node.trigger?.enabled || ['queued', 'running'].includes(node.status ?? '')) continue
    if (node.trigger.action === 'generate_video' && node.kind !== 'video') continue
    if (node.trigger.action !== 'generate_video' && (node.kind !== 'image' || !node.asset)) continue
    const sourceKeys = (incoming.get(node.id) ?? [])
      .map(completedOutputKey)
      .filter((value): value is string => Boolean(value))
      .sort()
    if (sourceKeys.length === 0) continue
    const runKey = `${node.trigger.action}|${sourceKeys.join('|')}`
    if (node.trigger.lastRunKey === runKey) continue
    runs.push({ nodeId: node.id, action: node.trigger.action, runKey })
  }
  return runs
}
