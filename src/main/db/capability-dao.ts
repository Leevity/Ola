import { getNativeWorker } from '../lib/native-worker'
import type { DesktopFlow, DesktopFlowRun } from '../../shared/desktop-flow'
import type { ProjectWikiDocument } from '../../shared/project-wiki'
import { wikiWorkspaceStorageKey } from '../wiki/wiki-workspace-key'
import {
  canaryGetWikiDocument,
  canaryListDesktopFlows,
  canaryListDesktopFlowRuns
} from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

interface WikiDocumentRow {
  projectRoot: string
  documentJson: string
  generatedAt: number
  updatedAt: number
}

interface MutationResult {
  success: boolean
  changed: number
  error?: string | null
}

function assertMutation(result: MutationResult, operation: string): void {
  if (!result.success) throw new Error(result.error || `Native capability ${operation} failed`)
}

export async function loadWikiDocument(
  projectRoot: string,
  workspaceId = 'local-personal'
): Promise<ProjectWikiDocument | null> {
  const migrated = await canaryGetWikiDocument(projectRoot, workspaceId)
  if (migrated !== undefined) return migrated
  const row = await getNativeWorker().request<WikiDocumentRow | null>(
    'db/wiki-get',
    { projectRoot: wikiWorkspaceStorageKey(projectRoot, workspaceId) },
    120_000
  )
  if (!row) return null
  try {
    const document = JSON.parse(row.documentJson) as ProjectWikiDocument
    return document.projectRoot === projectRoot ? document : null
  } catch {
    return null
  }
}

export async function saveWikiDocument(
  document: ProjectWikiDocument,
  workspaceId = 'local-personal'
): Promise<void> {
  const documentJson = JSON.stringify(document)
  if (Buffer.byteLength(documentJson, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('Project Wiki document is too large to persist.')
  }
  const writer = businessWriteCanary()
  if (writer) {
    await writer.saveWikiDocument(document, workspaceId, document.generatedAt)
    return
  }
  const result = await getNativeWorker().request<MutationResult>(
    'db/wiki-save',
    {
      projectRoot: wikiWorkspaceStorageKey(document.projectRoot, workspaceId),
      documentJson,
      generatedAt: document.generatedAt
    },
    120_000
  )
  assertMutation(result, 'wiki save')
}

export async function deleteWikiDocument(
  projectRoot: string,
  workspaceId = 'local-personal'
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.deleteWikiDocument(projectRoot, workspaceId)
    return
  }
  const result = await getNativeWorker().request<MutationResult>(
    'db/wiki-delete',
    { projectRoot: wikiWorkspaceStorageKey(projectRoot, workspaceId) },
    120_000
  )
  assertMutation(result, 'wiki delete')
}

export async function listPersistedDesktopFlows(
  workspaceId = 'local-personal'
): Promise<DesktopFlow[]> {
  const migrated = await canaryListDesktopFlows(workspaceId)
  const rows =
    migrated ??
    (await getNativeWorker().request<string[]>('db/desktop-flows-list', { workspaceId }, 120_000))
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row) as DesktopFlow]
    } catch {
      return []
    }
  })
}

export async function persistDesktopFlow(
  flow: DesktopFlow,
  workspaceId = 'local-personal'
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.saveDesktopFlow(flow, workspaceId)
    return
  }
  const result = await getNativeWorker().request<MutationResult>(
    'db/desktop-flow-save',
    {
      id: flow.id,
      name: flow.name,
      flowJson: JSON.stringify(flow),
      createdAt: flow.createdAt,
      workspaceId
    },
    120_000
  )
  assertMutation(result, 'desktop flow save')
}

export async function deletePersistedDesktopFlow(
  id: string,
  workspaceId = 'local-personal'
): Promise<boolean> {
  const writer = businessWriteCanary()
  if (writer) return writer.deleteDesktopFlow(id, workspaceId)
  const result = await getNativeWorker().request<MutationResult>(
    'db/desktop-flow-delete',
    { id, workspaceId },
    120_000
  )
  assertMutation(result, 'desktop flow delete')
  return result.changed > 0
}

export async function startPersistedDesktopFlowRun(
  id: string,
  flowId: string,
  workspaceId: string,
  startedAt: number
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.startDesktopFlowRun(id, flowId, workspaceId, startedAt)
    return
  }
  const result = await getNativeWorker().request<MutationResult>(
    'db/desktop-flow-run-start',
    { id, flowId, workspaceId, startedAt },
    120_000
  )
  assertMutation(result, 'desktop flow run start')
}

export async function finishPersistedDesktopFlowRun(
  id: string,
  workspaceId: string,
  state: 'succeeded' | 'failed' | 'cancelled',
  errorMessage?: string | null,
  finishedAt = Date.now()
): Promise<boolean> {
  const writer = businessWriteCanary()
  if (writer) return writer.finishDesktopFlowRun(id, workspaceId, state, finishedAt)
  const result = await getNativeWorker().request<MutationResult>(
    'db/desktop-flow-run-finish',
    { id, workspaceId, state, errorMessage, finishedAt },
    120_000
  )
  assertMutation(result, 'desktop flow run finish')
  return result.changed > 0
}

export async function listPersistedDesktopFlowRuns(
  workspaceId: string,
  limit = 100
): Promise<DesktopFlowRun[]> {
  const migrated = await canaryListDesktopFlowRuns(workspaceId, limit)
  const rows =
    migrated ??
    (await getNativeWorker().request<string[]>(
      'db/desktop-flow-runs-list',
      { workspaceId, limit },
      120_000
    ))
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row) as DesktopFlowRun]
    } catch {
      return []
    }
  })
}
