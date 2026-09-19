import { expect, it } from 'vitest'
import {
  reconcileDesktopFlows,
  type DesktopFlowReconciliationPorts
} from '../../src/main/desktop/desktop-flow-reconciliation'
import type { DesktopFlow, DesktopFlowRun } from '../../src/shared/desktop-flow'

function flow(id: string, updatedAt: number): DesktopFlow {
  return { id, workspaceId: 'team-a', name: id, createdAt: 1, updatedAt, steps: [] }
}

function fixture() {
  const nativeFlows = new Map<string, DesktopFlow>([
    ['old-flow', flow('old-flow', 1)],
    ['deleted-flow', flow('deleted-flow', 1)]
  ])
  const localFlows = [flow('old-flow', 2), flow('new-flow', 3)]
  const nativeRuns = new Map<string, DesktopFlowRun>()
  const localRuns: DesktopFlowRun[] = [
    {
      id: 'run-a',
      flowId: 'new-flow',
      state: 'cancelled',
      errorMessage: 'Cancelled',
      startedAt: 4,
      finishedAt: 5
    }
  ]
  let authorized = true
  const ports: DesktopFlowReconciliationPorts = {
    authorize: async () => {
      if (!authorized) throw new Error('WORKSPACE_REVOKED')
    },
    listNativeFlows: async () => [...nativeFlows.values()],
    saveNativeFlow: async (item) => {
      nativeFlows.set(item.id, item)
    },
    deleteNativeFlow: async (id) => nativeFlows.delete(id),
    listNativeRuns: async () => [...nativeRuns.values()],
    startNativeRun: async (run) => {
      nativeRuns.set(run.id, { ...run, state: 'running', errorMessage: null, finishedAt: null })
    },
    finishNativeRun: async (run) => {
      const existing = nativeRuns.get(run.id)
      if (existing?.state !== 'running') return false
      nativeRuns.set(run.id, run)
      return true
    },
    listLocalFlows: () => localFlows,
    listLocalDeletions: () => ['deleted-flow'],
    listLocalRuns: () => localRuns
  }
  return { ports, nativeFlows, nativeRuns, revoke: () => (authorized = false) }
}

it('reconciles local changes into Native by workspace without repeating completed work', async () => {
  const input = fixture()
  await expect(reconcileDesktopFlows(input.ports)).resolves.toEqual({
    savedFlows: 2,
    deletedFlows: 1,
    savedRuns: 1,
    failed: 0
  })
  expect([...input.nativeFlows.keys()].sort()).toEqual(['new-flow', 'old-flow'])
  expect(input.nativeRuns.get('run-a')?.state).toBe('cancelled')
  await expect(reconcileDesktopFlows(input.ports)).resolves.toEqual({
    savedFlows: 0,
    deletedFlows: 0,
    savedRuns: 0,
    failed: 0
  })
})

it('stops reconciliation when team authorization is revoked', async () => {
  const input = fixture()
  input.revoke()
  await expect(reconcileDesktopFlows(input.ports)).rejects.toThrow('WORKSPACE_REVOKED')
  expect([...input.nativeFlows.keys()].sort()).toEqual(['deleted-flow', 'old-flow'])
})

it('eventually reaches later flows when the first bounded batch keeps failing', async () => {
  const input = fixture()
  const cursor = { afterKey: null as string | null }
  const attempted: string[] = []
  const ports: DesktopFlowReconciliationPorts = {
    ...input.ports,
    listNativeFlows: async () => [],
    listNativeRuns: async () => [],
    listLocalDeletions: () => [],
    listLocalRuns: () => [],
    listLocalFlows: () => [
      ...Array.from({ length: 25 }, (_, index) => flow(`broken-${index}`, 2)),
      flow('healthy', 2)
    ],
    saveNativeFlow: async (item) => {
      attempted.push(item.id)
      if (item.id !== 'healthy') throw new Error('WRITE_UNAVAILABLE')
      input.nativeFlows.set(item.id, item)
    }
  }
  await expect(reconcileDesktopFlows(ports, cursor)).resolves.toMatchObject({
    savedFlows: 0,
    failed: 20
  })
  await expect(reconcileDesktopFlows(ports, cursor)).resolves.toMatchObject({
    savedFlows: 1,
    failed: 19
  })
  expect(attempted).toContain('healthy')
  expect(input.nativeFlows.has('healthy')).toBe(true)
})

it('keeps advancing when successful candidates disappear from later batches', async () => {
  const input = fixture()
  const cursor = { afterKey: null as string | null }
  const healthy = Array.from({ length: 80 }, (_, index) => flow(`healthy-${index}`, 2))
  const ports: DesktopFlowReconciliationPorts = {
    ...input.ports,
    listNativeFlows: async () => [...input.nativeFlows.values()],
    listNativeRuns: async () => [],
    listLocalDeletions: () => [],
    listLocalRuns: () => [],
    listLocalFlows: () => [
      ...Array.from({ length: 20 }, (_, index) => flow(`broken-${index}`, 2)),
      ...healthy
    ],
    saveNativeFlow: async (item) => {
      if (item.id.startsWith('broken-')) throw new Error('WRITE_UNAVAILABLE')
      input.nativeFlows.set(item.id, item)
    }
  }
  for (let round = 0; round < 10; round++) await reconcileDesktopFlows(ports, cursor)
  expect(healthy.every((item) => input.nativeFlows.has(item.id))).toBe(true)
})

it('reconciles flow definitions even when Native run history is unavailable', async () => {
  const input = fixture()
  const ports: DesktopFlowReconciliationPorts = {
    ...input.ports,
    listNativeRuns: async () => {
      throw new Error('RUN_LIST_UNAVAILABLE')
    }
  }
  await expect(reconcileDesktopFlows(ports)).resolves.toEqual({
    savedFlows: 2,
    deletedFlows: 1,
    savedRuns: 0,
    failed: 1
  })
  expect(input.nativeFlows.has('new-flow')).toBe(true)
})
