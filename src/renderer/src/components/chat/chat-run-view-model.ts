import type { TokenUsage } from '@renderer/lib/api/types'
import type { AgentRunChangeSet } from '@renderer/stores/agent-store'
import type { TaskItem } from '@renderer/stores/task-store'
import { aggregateDisplayableRunFileChanges, summarizeTrackedChange } from './file-change-utils'
import type {
  ToolExecutionCategory,
  ToolExecutionRun,
  ToolExecutionStatus
} from './execution-outline'

export interface ChatRunPresentation {
  status: ToolExecutionStatus
  stepCount: number
  durationMs?: number
  categoryCounts: Partial<Record<ToolExecutionCategory, number>>
  changeSummary: {
    fileCount: number
    added: number
    deleted: number
    undoableCount: number
    runId?: string
  }
  attentionCount: number
  pendingTaskCount: number
  usageTotalTokens: number
}

function mergedRunStatus(runs: readonly ToolExecutionRun[]): ToolExecutionStatus {
  if (runs.some((run) => run.status === 'pending-approval')) return 'pending-approval'
  if (runs.some((run) => run.status === 'failed')) return 'failed'
  if (runs.some((run) => run.status === 'running')) return 'running'
  if (runs.some((run) => run.status === 'canceled')) return 'canceled'
  return 'completed'
}

function totalUsageTokens(usage?: TokenUsage): number {
  if (!usage) return 0
  return [usage.inputTokens, usage.outputTokens, usage.reasoningTokens].reduce<number>(
    (total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
    0
  )
}

export function buildChatRunPresentation({
  runs,
  changeSet,
  tasks = [],
  usage
}: {
  runs: readonly ToolExecutionRun[]
  changeSet?: AgentRunChangeSet
  tasks?: readonly TaskItem[]
  usage?: TokenUsage
}): ChatRunPresentation | null {
  if (runs.length === 0 && !changeSet) return null

  const categoryCounts: Partial<Record<ToolExecutionCategory, number>> = {}
  let stepCount = 0
  let durationMs = 0
  let hasDuration = false

  for (const run of runs) {
    stepCount += run.visibleItems.length
    if (run.durationMs !== undefined) {
      durationMs += run.durationMs
      hasDuration = true
    }
    for (const [category, count] of Object.entries(run.categoryCounts) as Array<
      [ToolExecutionCategory, number]
    >) {
      categoryCounts[category] = (categoryCounts[category] ?? 0) + count
    }
  }

  const changes = aggregateDisplayableRunFileChanges(changeSet?.changes ?? [])
  const changeSummary = changes.reduce(
    (summary, change) => {
      const stats = summarizeTrackedChange(change)
      summary.added += stats.added
      summary.deleted += stats.deleted
      if (change.status === 'open') summary.undoableCount += 1
      return summary
    },
    {
      fileCount: changes.length,
      added: 0,
      deleted: 0,
      undoableCount: 0,
      ...(changeSet ? { runId: changeSet.runId } : {})
    }
  )

  const pendingTaskCount = tasks.filter(
    (task) => task.status === 'pending' || task.status === 'in_progress'
  ).length
  const attentionCount =
    runs.filter((run) => run.status === 'failed' || run.status === 'pending-approval').length +
    pendingTaskCount

  return {
    status: runs.length > 0 ? mergedRunStatus(runs) : 'completed',
    stepCount,
    ...(hasDuration ? { durationMs } : {}),
    categoryCounts,
    changeSummary,
    attentionCount,
    pendingTaskCount,
    usageTotalTokens: totalUsageTokens(usage)
  }
}
