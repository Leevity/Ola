import { expect, it } from 'vitest'
import { WorkspaceLoadGate } from '../../src/renderer/src/lib/workbench/workspace-load-gate'

it('does not accept a late session load after A→B→A workspace changes', () => {
  const gate = new WorkspaceLoadGate()
  const firstA = gate.begin('team-a')
  expect(gate.accepts(firstA, 'team-a')).toBe(true)
  const teamB = gate.begin('team-b')
  expect(gate.accepts(firstA, 'team-a')).toBe(false)
  expect(gate.accepts(teamB, 'team-b')).toBe(true)
  const secondA = gate.begin('team-a')
  expect(gate.accepts(firstA, 'team-a')).toBe(false)
  expect(gate.accepts(secondA, 'team-a')).toBe(true)
  expect(gate.accepts(secondA, 'local-personal')).toBe(false)
})

it('prefers the latest refresh inside the same workspace', () => {
  const gate = new WorkspaceLoadGate()
  const oldRefresh = gate.begin('local-personal')
  const newRefresh = gate.begin('local-personal')
  expect(gate.accepts(oldRefresh, 'local-personal')).toBe(false)
  expect(gate.accepts(newRefresh, 'local-personal')).toBe(true)
})
