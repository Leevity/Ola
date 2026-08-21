import { getNativeWorker } from '../lib/native-worker'
import type { DesktopFlow } from '../../shared/desktop-flow'
import type { ProjectWikiDocument } from '../../shared/project-wiki'

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

export async function loadWikiDocument(projectRoot: string): Promise<ProjectWikiDocument | null> {
  const row = await getNativeWorker().request<WikiDocumentRow | null>(
    'db/wiki-get',
    { projectRoot },
    120_000
  )
  if (!row) return null
  try {
    return JSON.parse(row.documentJson) as ProjectWikiDocument
  } catch {
    return null
  }
}

export async function saveWikiDocument(document: ProjectWikiDocument): Promise<void> {
  const documentJson = JSON.stringify(document)
  if (Buffer.byteLength(documentJson, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('Project Wiki document is too large to persist.')
  }
  const result = await getNativeWorker().request<MutationResult>(
    'db/wiki-save',
    {
      projectRoot: document.projectRoot,
      documentJson,
      generatedAt: document.generatedAt
    },
    120_000
  )
  assertMutation(result, 'wiki save')
}

export async function deleteWikiDocument(projectRoot: string): Promise<void> {
  const result = await getNativeWorker().request<MutationResult>(
    'db/wiki-delete',
    { projectRoot },
    120_000
  )
  assertMutation(result, 'wiki delete')
}

export async function listPersistedDesktopFlows(): Promise<DesktopFlow[]> {
  const rows = await getNativeWorker().request<string[]>('db/desktop-flows-list', {}, 120_000)
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row) as DesktopFlow]
    } catch {
      return []
    }
  })
}

export async function persistDesktopFlow(flow: DesktopFlow): Promise<void> {
  const result = await getNativeWorker().request<MutationResult>(
    'db/desktop-flow-save',
    {
      id: flow.id,
      name: flow.name,
      flowJson: JSON.stringify(flow),
      createdAt: flow.createdAt
    },
    120_000
  )
  assertMutation(result, 'desktop flow save')
}

export async function deletePersistedDesktopFlow(id: string): Promise<boolean> {
  const result = await getNativeWorker().request<MutationResult>(
    'db/desktop-flow-delete',
    { id },
    120_000
  )
  assertMutation(result, 'desktop flow delete')
  return result.changed > 0
}
