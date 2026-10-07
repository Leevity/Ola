import type { TaskItem, TaskStatus } from '@renderer/stores/task-store'

export const TASK_BOARD_STATUS_ORDER: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'in_review',
  'blocked',
  'completed',
  'failed',
  'cancelled'
]

export function taskBoardStatusCounts(tasks: readonly TaskItem[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    in_review: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  }
  for (const task of tasks) counts[task.status]++
  return counts
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
