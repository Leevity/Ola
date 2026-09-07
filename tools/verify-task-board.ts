import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const boardSource = readFileSync('src/renderer/src/components/tasks/TaskBoardPage.tsx', 'utf8')
const storeSource = readFileSync('src/renderer/src/stores/task-board-store.ts', 'utf8')
const taskStoreSource = readFileSync('src/renderer/src/stores/task-store.ts', 'utf8')

assert.match(boardSource, /value: 'dashboard'/)
assert.match(boardSource, /value: 'kanban'/)
assert.match(boardSource, /value: 'list'/)
assert.match(boardSource, /value: 'gantt'/)
assert.match(storeSource, /DB_TASKS_LIST_ALL_MSGPACK_CHANNEL/)
assert.match(storeSource, /useTaskStore\.getState\(\)\.updateTask/)
assert.match(taskStoreSource, /readTaskBoardMetadata/)
assert.match(taskStoreSource, /withTaskBoardMetadata/)

console.log('Task board projection verification passed')
