import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopFlow } from '../../src/shared/desktop-flow'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))

import {
  deleteDesktopFlow,
  finishDesktopFlowRun,
  listDesktopFlowDeletions,
  listDesktopFlows,
  listDesktopFlowRuns,
  saveDesktopFlow,
  startDesktopFlowRun
} from '../../src/main/desktop/desktop-flow-store'
import {
  getActiveDesktopFlow,
  recordDesktopFlowStep,
  startDesktopFlowRecording,
  stopDesktopFlowRecording
} from '../../src/main/desktop/desktop-flow-recorder'

afterEach(async () => {
  stopDesktopFlowRecording()
  if (state.directory) await rm(state.directory, { recursive: true, force: true })
  state.directory = ''
})

it('keeps legacy personal flow files separate from team files with the same ID', async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'ola-flow-workspace-'))
  const id = '11111111-1111-4111-8111-111111111111'
  const personal: DesktopFlow = { id, name: 'Personal', createdAt: 1, updatedAt: 1, steps: [] }
  const team: DesktopFlow = {
    ...personal,
    name: 'Team',
    workspaceId: 'team-a'
  }
  saveDesktopFlow(personal, 'local-personal')
  saveDesktopFlow(team, 'team-a')
  expect(listDesktopFlows('local-personal').map((flow) => flow.name)).toEqual(['Personal'])
  expect(listDesktopFlows('team-a').map((flow) => flow.name)).toEqual(['Team'])
  expect(() => saveDesktopFlow(team, 'local-personal')).toThrow('another workspace')
  expect(deleteDesktopFlow(id, 'team-a')).toBe(true)
  expect(listDesktopFlows('team-a')).toEqual([])
  expect(listDesktopFlowDeletions('team-a')).toEqual([id])
  expect(listDesktopFlows('local-personal').map((flow) => flow.name)).toEqual(['Personal'])
  saveDesktopFlow(team, 'team-a')
  expect(listDesktopFlowDeletions('team-a')).toEqual([])
  expect(listDesktopFlows('team-a').map((flow) => flow.name)).toEqual(['Team'])
})

it('records steps only from the window that started the workspace-scoped flow', () => {
  const flow = startDesktopFlowRecording('Team flow', { workspaceId: 'team-a', ownerId: 11 })
  expect(flow.workspaceId).toBe('team-a')
  recordDesktopFlowStep({ type: 'click', x: 1, y: 1 }, 12)
  recordDesktopFlowStep({ type: 'click', x: 2, y: 2 })
  expect(getActiveDesktopFlow()?.steps).toEqual([])
  recordDesktopFlowStep({ type: 'click', x: 3, y: 3 }, 11)
  expect(getActiveDesktopFlow()?.steps).toHaveLength(1)
  expect(() =>
    startDesktopFlowRecording('Other', { workspaceId: 'local-personal', ownerId: 12 })
  ).toThrow('DESKTOP_FLOW_RECORDING_ACTIVE')
})

it('marks omitted typing as requiring review instead of treating it as replayable', async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'ola-flow-typing-'))
  startDesktopFlowRecording('Typed flow', { workspaceId: 'team-a', ownerId: 11 })
  recordDesktopFlowStep({ type: 'type', text: 'private input' }, 11)
  const recorded = stopDesktopFlowRecording()!
  expect(recorded.requiresReview).toBe(true)
  expect(recorded.steps[0].text).toBeUndefined()
  saveDesktopFlow(recorded, 'team-a')
  expect(listDesktopFlows('team-a')[0].requiresReview).toBe(true)
})

it('keeps offline run journals scoped to their workspace and removes them with the flow', async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'ola-flow-runs-'))
  const flowId = '11111111-1111-4111-8111-111111111111'
  const runId = '22222222-2222-4222-8222-222222222222'
  const base: DesktopFlow = { id: flowId, name: 'Flow', createdAt: 1, updatedAt: 1, steps: [] }
  saveDesktopFlow(base, 'local-personal')
  saveDesktopFlow({ ...base, workspaceId: 'team-a' }, 'team-a')
  startDesktopFlowRun(runId, flowId, 'team-a', 2)
  expect(listDesktopFlowRuns('local-personal')).toEqual([])
  expect(listDesktopFlowRuns('team-a')).toMatchObject([{ id: runId, state: 'running' }])
  expect(finishDesktopFlowRun(runId, 'local-personal', 'failed', 3)).toBe(false)
  expect(finishDesktopFlowRun(runId, 'team-a', 'cancelled', 3)).toBe(true)
  expect(listDesktopFlowRuns('team-a')).toMatchObject([{ state: 'cancelled', finishedAt: 3 }])
  expect(deleteDesktopFlow(flowId, 'team-a')).toBe(true)
  expect(listDesktopFlowRuns('team-a')).toEqual([])
  expect(listDesktopFlows('local-personal')).toHaveLength(1)
})
