import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, join } from 'path'
import type { DesktopFlow, DesktopFlowRun } from '../../shared/desktop-flow'

const MAX_FLOWS = 100
const MAX_STEPS = 1000
const MAX_NAME_LENGTH = 160
const MAX_TEXT_LENGTH = 100_000
const MAX_FLOW_JSON_BYTES = 5 * 1024 * 1024

function flowDirectory(workspaceId: string): string {
  const root = join(app.getPath('userData'), 'desktop-flows')
  const directory =
    workspaceId === 'local-personal'
      ? root
      : join(root, 'workspaces', createHash('sha256').update(workspaceId).digest('hex'))
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function flowPath(id: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid desktop flow ID.')
  return join(flowDirectory(workspaceId), `${id}.json`)
}

function runDirectory(workspaceId: string): string {
  const directory = join(flowDirectory(workspaceId), 'runs')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function runPath(id: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid desktop flow run ID.')
  return join(runDirectory(workspaceId), `${id}.json`)
}

function deletionDirectory(workspaceId: string): string {
  const directory = join(flowDirectory(workspaceId), 'deletions')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function deletionPath(id: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid desktop flow ID.')
  return join(deletionDirectory(workspaceId), `${id}.json`)
}

export function isDesktopFlowDeleted(id: string, workspaceId = 'local-personal'): boolean {
  return existsSync(deletionPath(id, workspaceId))
}

export function redactDesktopFlowCapturedText(flow: DesktopFlow): DesktopFlow {
  const normalized = structuredClone({ ...flow, name: flow.name.trim() })
  let removedCapturedText = false
  let hasTypingSteps = false
  for (const step of normalized.steps) {
    if (step.type === 'type') hasTypingSteps = true
    if (step.type === 'type' && typeof step.text === 'string' && step.text.length > 0) {
      delete step.text
      step.expectedChange =
        step.expectedChange ?? 'Captured input removed for safety. Recreate this step.'
      removedCapturedText = true
    }
  }
  if (removedCapturedText || hasTypingSteps) normalized.requiresReview = true
  return normalized
}

function validateFlow(flow: DesktopFlow, workspaceId: string): DesktopFlow {
  if (!flow || typeof flow !== 'object' || !/^[0-9a-f-]{36}$/i.test(flow.id)) {
    throw new Error('Invalid desktop flow.')
  }
  if (typeof flow.name !== 'string' || !flow.name.trim() || flow.name.length > MAX_NAME_LENGTH) {
    throw new Error('Desktop flow name is invalid.')
  }
  if (!Array.isArray(flow.steps) || flow.steps.length > MAX_STEPS) {
    throw new Error('Desktop flow has too many steps.')
  }
  if ((flow.workspaceId ?? 'local-personal') !== workspaceId)
    throw new Error('Desktop flow belongs to another workspace.')
  for (const step of flow.steps) {
    if (!step || typeof step !== 'object' || typeof step.type !== 'string') {
      throw new Error('Desktop flow contains an invalid step.')
    }
    if (typeof step.text === 'string' && step.text.length > MAX_TEXT_LENGTH) {
      throw new Error('Desktop flow text is too large.')
    }
  }
  const normalized = redactDesktopFlowCapturedText(flow)
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_FLOW_JSON_BYTES) {
    throw new Error('Desktop flow is too large.')
  }
  return normalized
}

function listPaths(workspaceId: string): string[] {
  try {
    return readdirSync(flowDirectory(workspaceId), { withFileTypes: true })
      .filter(
        (entry: { isFile: () => boolean; name: string }) =>
          entry.isFile() && entry.name.endsWith('.json')
      )
      .map((entry: { name: string }) => join(flowDirectory(workspaceId), entry.name))
  } catch {
    return []
  }
}

function writeRecord(
  path: string,
  record: DesktopFlow | DesktopFlowRun | { id: string; deletedAt: number }
): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

export function listDesktopFlows(workspaceId = 'local-personal'): DesktopFlow[] {
  return listPaths(workspaceId)
    .map((path) => {
      try {
        const flow = validateFlow(
          JSON.parse(readFileSync(path, 'utf8')) as DesktopFlow,
          workspaceId
        )
        if (flow.requiresReview) writeRecord(path, flow)
        return flow
      } catch {
        return null
      }
    })
    .filter((flow): flow is DesktopFlow => flow !== null)
    .filter((flow) => !isDesktopFlowDeleted(flow.id, workspaceId))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_FLOWS)
}

export function saveDesktopFlow(flow: DesktopFlow, workspaceId = 'local-personal'): DesktopFlow {
  const validated = validateFlow(flow, workspaceId)
  const current = listDesktopFlows(workspaceId).filter((item) => item.id !== validated.id)
  if (current.length >= MAX_FLOWS && !existsSync(flowPath(validated.id, workspaceId))) {
    throw new Error('Desktop flow limit reached.')
  }
  const target = flowPath(validated.id, workspaceId)
  writeRecord(target, validated)
  const deletedPath = deletionPath(validated.id, workspaceId)
  if (existsSync(deletedPath)) unlinkSync(deletedPath)
  return validated
}

export function deleteDesktopFlow(id: string, workspaceId = 'local-personal'): boolean {
  const path = flowPath(id, workspaceId)
  const deletedPath = deletionPath(id, workspaceId)
  const wasDeleted = existsSync(deletedPath)
  const hasFlow = existsSync(path)
  const runs = hasFlow
    ? listDesktopFlowRuns(workspaceId, Number.MAX_SAFE_INTEGER).filter((run) => run.flowId === id)
    : []
  writeRecord(deletedPath, { id, deletedAt: Date.now() })
  if (!hasFlow) return !wasDeleted
  unlinkSync(path)
  for (const run of runs) unlinkSync(runPath(run.id, workspaceId))
  return true
}

export function listDesktopFlowDeletions(workspaceId = 'local-personal'): string[] {
  try {
    return readdirSync(deletionDirectory(workspaceId), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name))
      .map((entry) => entry.name.slice(0, -5))
  } catch {
    return []
  }
}

export function listDesktopFlowRuns(workspaceId = 'local-personal', limit = 100): DesktopFlowRun[] {
  let paths: string[]
  try {
    paths = readdirSync(runDirectory(workspaceId), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name))
      .map((entry) => join(runDirectory(workspaceId), entry.name))
  } catch {
    return []
  }
  return paths
    .flatMap((path) => {
      try {
        const run = JSON.parse(readFileSync(path, 'utf8')) as DesktopFlowRun
        if (
          !run ||
          typeof run.id !== 'string' ||
          typeof run.flowId !== 'string' ||
          typeof run.startedAt !== 'number' ||
          basename(path) !== `${run.id}.json` ||
          !/^[0-9a-f-]{36}$/i.test(run.flowId) ||
          isDesktopFlowDeleted(run.flowId, workspaceId) ||
          !existsSync(flowPath(run.flowId, workspaceId)) ||
          !['running', 'succeeded', 'failed', 'cancelled'].includes(run.state)
        )
          return []
        return [run]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, limit)
}

export function startDesktopFlowRun(
  id: string,
  flowId: string,
  workspaceId: string,
  startedAt: number
): DesktopFlowRun {
  if (!existsSync(flowPath(flowId, workspaceId)))
    throw new Error('Desktop flow is unavailable in this workspace.')
  if (isDesktopFlowDeleted(flowId, workspaceId))
    throw new Error('Desktop flow has been deleted in this workspace.')
  const path = runPath(id, workspaceId)
  if (existsSync(path)) throw new Error('Desktop flow run already exists.')
  const run: DesktopFlowRun = {
    id,
    flowId,
    state: 'running',
    errorMessage: null,
    startedAt,
    finishedAt: null
  }
  writeRecord(path, run)
  return run
}

export function finishDesktopFlowRun(
  id: string,
  workspaceId: string,
  state: 'succeeded' | 'failed' | 'cancelled',
  finishedAt: number,
  errorMessage?: string | null
): boolean {
  const path = runPath(id, workspaceId)
  if (!existsSync(path)) return false
  const run = JSON.parse(readFileSync(path, 'utf8')) as DesktopFlowRun
  if (run.id !== id || run.state !== 'running') return false
  writeRecord(path, { ...run, state, errorMessage: errorMessage ?? null, finishedAt })
  return true
}
