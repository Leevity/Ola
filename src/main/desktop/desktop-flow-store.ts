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
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { DesktopFlow } from '../../shared/desktop-flow'

const MAX_FLOWS = 100
const MAX_STEPS = 1000
const MAX_NAME_LENGTH = 160
const MAX_TEXT_LENGTH = 100_000
const MAX_FLOW_JSON_BYTES = 5 * 1024 * 1024

function flowDirectory(): string {
  const directory = join(app.getPath('userData'), 'desktop-flows')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return directory
}

function flowPath(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid desktop flow ID.')
  return join(flowDirectory(), `${id}.json`)
}

function validateFlow(flow: DesktopFlow): DesktopFlow {
  if (!flow || typeof flow !== 'object' || !/^[0-9a-f-]{36}$/i.test(flow.id)) {
    throw new Error('Invalid desktop flow.')
  }
  if (typeof flow.name !== 'string' || !flow.name.trim() || flow.name.length > MAX_NAME_LENGTH) {
    throw new Error('Desktop flow name is invalid.')
  }
  if (!Array.isArray(flow.steps) || flow.steps.length > MAX_STEPS) {
    throw new Error('Desktop flow has too many steps.')
  }
  for (const step of flow.steps) {
    if (!step || typeof step !== 'object' || typeof step.type !== 'string') {
      throw new Error('Desktop flow contains an invalid step.')
    }
    if (typeof step.text === 'string' && step.text.length > MAX_TEXT_LENGTH) {
      throw new Error('Desktop flow text is too large.')
    }
  }
  const normalized = structuredClone({ ...flow, name: flow.name.trim() })
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_FLOW_JSON_BYTES) {
    throw new Error('Desktop flow is too large.')
  }
  return normalized
}

function listPaths(): string[] {
  try {
    return readdirSync(flowDirectory(), { withFileTypes: true })
      .filter(
        (entry: { isFile: () => boolean; name: string }) =>
          entry.isFile() && entry.name.endsWith('.json')
      )
      .map((entry: { name: string }) => join(flowDirectory(), entry.name))
  } catch {
    return []
  }
}

export function listDesktopFlows(): DesktopFlow[] {
  return listPaths()
    .map((path) => {
      try {
        return validateFlow(JSON.parse(readFileSync(path, 'utf8')) as DesktopFlow)
      } catch {
        return null
      }
    })
    .filter((flow): flow is DesktopFlow => flow !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_FLOWS)
}

export function saveDesktopFlow(flow: DesktopFlow): DesktopFlow {
  const validated = validateFlow(flow)
  const current = listDesktopFlows().filter((item) => item.id !== validated.id)
  if (current.length >= MAX_FLOWS && !existsSync(flowPath(validated.id))) {
    throw new Error('Desktop flow limit reached.')
  }
  const target = flowPath(validated.id)
  const temporary = `${target}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(validated, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, target)
  return validated
}

export function deleteDesktopFlow(id: string): boolean {
  const path = flowPath(id)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}
