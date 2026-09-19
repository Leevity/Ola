import type { DesktopFlow, DesktopFlowRun } from '../../shared/desktop-flow'

export interface DesktopFlowReconciliationPorts {
  authorize(): Promise<void>
  listNativeFlows(): Promise<DesktopFlow[]>
  saveNativeFlow(flow: DesktopFlow): Promise<void>
  deleteNativeFlow(id: string): Promise<boolean>
  listNativeRuns(): Promise<DesktopFlowRun[]>
  startNativeRun(run: DesktopFlowRun): Promise<void>
  finishNativeRun(run: DesktopFlowRun): Promise<boolean>
  listLocalFlows(): DesktopFlow[]
  listLocalDeletions(): string[]
  listLocalRuns(): DesktopFlowRun[]
}

export interface DesktopFlowReconciliationResult {
  savedFlows: number
  deletedFlows: number
  savedRuns: number
  failed: number
}

export interface DesktopFlowReconciliationCursor {
  afterKey: string | null
}

const MAX_RECONCILE_MUTATIONS = 20

/** Retry-safe local-to-Native reconciliation; local copies remain available offline. */
export async function reconcileDesktopFlows(
  ports: DesktopFlowReconciliationPorts,
  cursor?: DesktopFlowReconciliationCursor
): Promise<DesktopFlowReconciliationResult> {
  await ports.authorize()
  const nativeFlows = await ports.listNativeFlows()
  const localFlows = ports.listLocalFlows()
  const deleted = new Set(ports.listLocalDeletions())
  const nativeById = new Map(nativeFlows.map((flow) => [flow.id, flow]))
  let nativeRuns: DesktopFlowRun[] = []
  let runsUnavailable = false
  try {
    nativeRuns = await ports.listNativeRuns()
  } catch {
    runsUnavailable = true
  }
  const nativeRunsById = new Map(nativeRuns.map((run) => [run.id, run]))
  const candidates: Array<
    | { kind: 'delete'; key: string; id: string }
    | { kind: 'save'; key: string; flow: DesktopFlow }
    | { kind: 'run'; key: string; run: DesktopFlowRun }
  > = [
    ...[...deleted]
      .filter((id) => nativeById.has(id))
      .map((id) => ({ kind: 'delete' as const, key: `0:delete:${id}`, id })),
    ...localFlows
      .filter(
        (flow) =>
          !deleted.has(flow.id) && flow.updatedAt > (nativeById.get(flow.id)?.updatedAt ?? -1)
      )
      .map((flow) => ({ kind: 'save' as const, key: `1:save:${flow.id}`, flow })),
    ...(runsUnavailable ? [] : ports.listLocalRuns())
      .filter((run) => run.state !== 'running' && !deleted.has(run.flowId))
      .filter(
        (run) => nativeRunsById.get(run.id)?.state === 'running' || !nativeRunsById.has(run.id)
      )
      .map((run) => ({ kind: 'run' as const, key: `2:run:${run.id}`, run }))
  ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  const result: DesktopFlowReconciliationResult = {
    savedFlows: 0,
    deletedFlows: 0,
    savedRuns: 0,
    failed: runsUnavailable ? 1 : 0
  }
  const afterKey = cursor?.afterKey
  const nextIndex = afterKey ? candidates.findIndex((candidate) => candidate.key > afterKey) : 0
  const start = nextIndex < 0 ? 0 : nextIndex
  const count = Math.min(candidates.length, MAX_RECONCILE_MUTATIONS)
  for (let index = 0; index < count; index++) {
    const candidate = candidates[(start + index) % candidates.length]
    if (candidate.kind === 'run' && !nativeById.has(candidate.run.flowId)) continue
    await ports.authorize()
    try {
      if (candidate.kind === 'delete') {
        if (await ports.deleteNativeFlow(candidate.id)) {
          nativeById.delete(candidate.id)
          result.deletedFlows++
        }
      } else if (candidate.kind === 'save') {
        await ports.saveNativeFlow(candidate.flow)
        nativeById.set(candidate.flow.id, candidate.flow)
        result.savedFlows++
      } else {
        const native = nativeRunsById.get(candidate.run.id)
        if (native?.flowId !== undefined && native.flowId !== candidate.run.flowId) {
          result.failed++
          continue
        }
        if (!native) await ports.startNativeRun(candidate.run)
        if (await ports.finishNativeRun(candidate.run)) {
          nativeRunsById.set(candidate.run.id, candidate.run)
          result.savedRuns++
        } else {
          result.failed++
        }
      }
    } catch {
      result.failed++
    }
  }
  if (cursor && count > 0) cursor.afterKey = candidates[(start + count - 1) % candidates.length].key
  await ports.authorize()
  return result
}
