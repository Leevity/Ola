import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  getWorkbenchActionsSnapshot,
  registerWorkbenchAction,
  registerWorkbenchDrawer,
  registerWorkbenchPane
} from '../src/renderer/src/lib/workbench/registry'

const unregister = registerWorkbenchAction({ id: 'test.action', title: 'Test action', run: () => {} })
assert.equal(getWorkbenchActionsSnapshot().some((action) => action.id === 'test.action'), true)
unregister()
assert.equal(getWorkbenchActionsSnapshot().some((action) => action.id === 'test.action'), false)
assert.equal(typeof registerWorkbenchPane({ id: 'test.pane', title: 'Test', area: 'right' }), 'function')
assert.equal(typeof registerWorkbenchDrawer({ id: 'test.drawer', title: 'Test', side: 'left' }), 'function')
assert.match(readFileSync('src/renderer/src/components/layout/CommandPalette.tsx', 'utf8'), /getWorkbenchActionsSnapshot/)

console.log('Workbench registry verification passed')
