import type { OrchestrationRun, OrchestrationSnapshot } from './types'

export function buildHistorySnapshot(
  run: Pick<OrchestrationRun, 'summary' | 'latestAction' | 'members'>
): OrchestrationSnapshot {
  return {
    summary: run.summary,
    latestAction: run.latestAction,
    members: run.members.map((member) => ({
      id: member.id,
      name: member.name,
      status: member.status,
      summary: member.summary,
      latestAction: member.latestAction,
      progress: member.progress,
      toolCallCount: member.toolCallCount,
      iteration: member.iteration
    }))
  }
}
