import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Every assertion below is about code, not layout, so the sources are read with
// whitespace collapsed. Patterns tolerate a space wherever the formatter may break a
// line: after `:` and around the dots of a wrapped member chain.
const boardSource = await readCollapsedSource('src/renderer/src/components/tasks/TaskBoardPage.tsx')
const storeSource = await readCollapsedSource('src/renderer/src/stores/task-board-store.ts')
const taskStoreSource = await readCollapsedSource('src/renderer/src/stores/task-store.ts')

assert.match(boardSource, /value:\s*'dashboard'/)
assert.match(boardSource, /value:\s*'kanban'/)
assert.match(boardSource, /value:\s*'list'/)
assert.match(boardSource, /value:\s*'gantt'/)
assert.match(storeSource, /DB_TASKS_LIST_ALL_MSGPACK_CHANNEL/)
assert.match(storeSource, /useTaskStore\s*\.\s*getState\(\s*\)\s*\.\s*updateTask/)
assert.match(taskStoreSource, /readTaskBoardMetadata/)
assert.match(taskStoreSource, /withTaskBoardMetadata/)

console.log('Task board projection verification passed')
