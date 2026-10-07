import { expect, it } from 'vitest'
import {
  isTerminalTaskStatus,
  TASK_BOARD_STATUS_ORDER,
  taskBoardStatusCounts
} from '../../src/renderer/src/lib/task-board-status'
import type { TaskItem, TaskStatus } from '../../src/renderer/src/stores/task-store'

it('keeps every persisted task state in the dashboard total', () => {
  const tasks = TASK_BOARD_STATUS_ORDER.map((status, index) => ({
    id: `task-${index}`,
    subject: status,
    description: '',
    status,
    blocks: [],
    blockedBy: [],
    createdAt: 1,
    updatedAt: 1
  })) satisfies TaskItem[]
  const counts = taskBoardStatusCounts(tasks)
  expect(TASK_BOARD_STATUS_ORDER).toHaveLength(7)
  expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(tasks.length)
  for (const status of TASK_BOARD_STATUS_ORDER) expect(counts[status]).toBe(1)
})

it('excludes all terminal task states from open deadline reminders', () => {
  expect(TASK_BOARD_STATUS_ORDER.filter(isTerminalTaskStatus)).toEqual([
    'completed',
    'failed',
    'cancelled'
  ] satisfies TaskStatus[])
})
