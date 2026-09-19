import { expect, it } from 'vitest'
import { MemoryPanelRequestGate } from '../../src/renderer/src/components/memory/memory-panel-request-gate'

it('rejects a late memory result after workspace or project changes', () => {
  const gate = new MemoryPanelRequestGate()
  const teamRequest = gate.begin('team-a:global', 'team-a')
  expect(gate.accepts(teamRequest, 'team-a')).toBe(true)
  expect(gate.accepts(teamRequest, 'local-personal')).toBe(false)
  gate.setScope('team-b:global')
  expect(gate.accepts(teamRequest, 'team-a')).toBe(false)
  gate.setScope('team-a:global')
  expect(gate.accepts(teamRequest, 'team-a')).toBe(false)
  const projectRequest = gate.begin('team-a:project-1', 'team-a')
  gate.setScope('team-a:project-2')
  expect(gate.accepts(projectRequest, 'team-a')).toBe(false)
})

it('only accepts the most recent request for the same panel scope', () => {
  const gate = new MemoryPanelRequestGate()
  const first = gate.begin('local-personal:global', 'local-personal')
  const second = gate.begin('local-personal:global', 'local-personal')
  expect(gate.accepts(first, 'local-personal')).toBe(false)
  expect(gate.accepts(second, 'local-personal')).toBe(true)
})
