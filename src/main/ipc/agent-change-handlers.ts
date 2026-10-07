import { createHash } from 'crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { ipcMain } from 'electron'
import { getSession } from '../db/sessions-dao'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { assertAgentChangeSetWorkspace, assertAgentChangeWorkspace } from './agent-change-workspace'
import {
  appendStoredFileChange,
  deleteStoredFinalizedRunChangeSetsOlderThan,
  getStoredRunChangeSet,
  listStoredRunChangeSetsBySession,
  markFileChangeReverted,
  recomputeRunStatus
} from '../db/agent-changes-dao'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { assertTrustedRendererIpcEvent } from '../renderer-security'

export type RunChangeStatus = 'open' | 'reverted'
export type FileChangeStatus = 'open' | 'reverted'
type ChangeOp = 'create' | 'modify'
type ChangeTransport = 'local' | 'ssh'

interface ChangeMeta {
  runId?: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
}

interface ListSessionRunChangesArgs {
  sessionId: string
  workspaceId: string
}

async function requireAgentChangeWorkspace(
  workspaceId: unknown,
  sessionId: string | null | undefined
): Promise<void> {
  await assertAgentChangeWorkspace(workspaceId, sessionId, {
    sessionWorkspace: async (id) => (await getSession(id))?.workspace_id ?? null,
    availableWorkspaceIds: loadOfflineWorkspaceIds
  })
}

async function requireRunWorkspace(runId: string, workspaceId: unknown): Promise<void> {
  const changeSet = await getStoredRunChangeSet(runId, String(workspaceId))
  await assertAgentChangeSetWorkspace(
    workspaceId,
    changeSet ? [changeSet.sessionId, ...changeSet.changes.map((change) => change.sessionId)] : [],
    {
      sessionWorkspace: async (id) => (await getSession(id))?.workspace_id ?? null,
      availableWorkspaceIds: loadOfflineWorkspaceIds
    }
  )
}

export interface FileSnapshot {
  exists: boolean
  text?: string
  fullText?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

export interface TrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: ChangeTransport
  connectionId?: string
  op: ChangeOp
  status: FileChangeStatus
  before: FileSnapshot
  after: FileSnapshot
  createdAt: number
  revertedAt?: number
}

export interface RunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: RunChangeStatus
  changes: TrackedFileChange[]
  createdAt: number
  updatedAt: number
}

interface SshChangeAdapter {
  readSnapshot: (connectionId: string, filePath: string) => Promise<FileSnapshot>
  writeText: (connectionId: string, filePath: string, content: string) => Promise<void>
  deleteFile: (connectionId: string, filePath: string) => Promise<void>
}

function registerAgentChangeMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    assertTrustedRendererIpcEvent(event)
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

let sshChangeAdapter: SshChangeAdapter | null = null

const INLINE_TEXT_SNAPSHOT_LIMIT_BYTES = 64 * 1024
const SNAPSHOT_PREVIEW_HEAD_CHARS = 1200
const SNAPSHOT_PREVIEW_TAIL_CHARS = 400
const FINALIZED_RUN_CHANGES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

let lastPruneAt = 0
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function buildFileSnapshot(exists: boolean, text?: string): FileSnapshot {
  if (!exists) {
    return {
      exists: false,
      hash: null,
      size: 0
    }
  }

  if (text === undefined) {
    return buildOpaqueExistingSnapshot()
  }

  const normalizedText = text
  const size = Buffer.byteLength(normalizedText, 'utf-8')
  const lineCount =
    normalizedText.length === 0 ? 0 : normalizedText.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text: normalizedText,
      fullText: normalizedText,
      hash: hashText(normalizedText),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    fullText: normalizedText,
    previewText: normalizedText.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(normalizedText.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: normalizedText.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(normalizedText),
    size,
    lineCount
  }
}

function buildLightSnapshot(text: string): FileSnapshot {
  const size = Buffer.byteLength(text, 'utf-8')
  const lineCount = text.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text,
      fullText: text,
      hash: hashText(text),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    previewText: text.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(text.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: text.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(text),
    size,
    lineCount
  }
}

export function buildOpaqueExistingSnapshot(): FileSnapshot {
  return {
    exists: true,
    hash: null,
    size: 0
  }
}

async function pruneStaleRunChangesIfNeeded(): Promise<void> {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  await deleteStoredFinalizedRunChangeSetsOlderThan(now - FINALIZED_RUN_CHANGES_RETENTION_MS)
}

function resolveRunId(meta?: ChangeMeta): string | null {
  const runId = meta?.runId?.trim()
  if (runId) return runId
  const toolUseId = meta?.toolUseId?.trim()
  if (toolUseId) return toolUseId
  return null
}

async function recordTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  before: FileSnapshot
  afterText: string
  transport: ChangeTransport
  connectionId?: string
}): Promise<void> {
  const runId = resolveRunId(args.meta)
  if (!runId) {
    console.warn(
      '[agent-changes] dropping change record: no runId or toolUseId in meta',
      args.filePath
    )
    return
  }

  const after = buildLightSnapshot(args.afterText)
  if (args.before.exists === after.exists && args.before.hash === after.hash) {
    return
  }

  const now = Date.now()
  const sessionId = args.meta?.sessionId?.trim() || undefined
  const session = sessionId ? await getSession(sessionId) : undefined
  if (sessionId && !session) throw new Error('agent-change-session-not-found')
  const workspaceId = session?.workspace_id ?? 'local-personal'
  await requireAgentChangeWorkspace(workspaceId, sessionId)
  const assistantMessageId = args.meta?.runId?.trim() || runId
  const existingForId = await getStoredRunChangeSet(runId, workspaceId)
  if (existingForId)
    await assertAgentChangeSetWorkspace(
      workspaceId,
      [existingForId.sessionId, ...existingForId.changes.map((item) => item.sessionId)],
      {
        sessionWorkspace: async (id) => (await getSession(id))?.workspace_id ?? null,
        availableWorkspaceIds: loadOfflineWorkspaceIds
      }
    )
  const sequence = (existingForId?.changes.length ?? 0) + 1

  const change: TrackedFileChange = {
    id: `${runId}:${sequence}`,
    runId,
    sessionId,
    toolUseId: args.meta?.toolUseId,
    toolName: args.meta?.toolName,
    filePath: args.filePath,
    transport: args.transport,
    connectionId: args.connectionId,
    op: args.before.exists ? 'modify' : 'create',
    status: 'open',
    before: args.before,
    after,
    createdAt: now
  }

  await appendStoredFileChange({
    runId,
    workspaceId,
    sessionId,
    assistantMessageId,
    change,
    now
  })
}

export async function recordLocalTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  beforeExists: boolean
  beforeText?: string
  afterText: string
}): Promise<void> {
  await recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: buildFileSnapshot(args.beforeExists, args.beforeText),
    afterText: args.afterText,
    transport: 'local'
  })
}

export async function recordSshTextWriteChange(args: {
  meta?: ChangeMeta
  connectionId: string
  filePath: string
  before: FileSnapshot
  afterText: string
}): Promise<void> {
  await recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: args.before,
    afterText: args.afterText,
    transport: 'ssh',
    connectionId: args.connectionId
  })
}

export function registerSshChangeAdapter(adapter: SshChangeAdapter): void {
  sshChangeAdapter = adapter
}

async function loadRunChangeSet(runId: string, workspaceId: string): Promise<RunChangeSet | null> {
  const changeSet = await getStoredRunChangeSet(runId, workspaceId)
  return changeSet ? await hydrateLocalAfterSnapshots(changeSet as RunChangeSet) : null
}

async function getRunChangeSetsBySession(
  sessionId: string,
  workspaceId: string
): Promise<RunChangeSet[]> {
  await pruneStaleRunChangesIfNeeded()
  const changeSets = await listStoredRunChangeSetsBySession(sessionId, workspaceId)
  return await Promise.all(changeSets.map((changeSet) => hydrateLocalAfterSnapshots(changeSet)))
}

async function hydrateLocalAfterSnapshots(changeSet: RunChangeSet): Promise<RunChangeSet> {
  return {
    ...changeSet,
    changes: await Promise.all(
      changeSet.changes.map(async (change) => ({
        ...change,
        before: { ...change.before },
        after: await hydrateLocalAfterSnapshot(change)
      }))
    )
  }
}

async function hydrateLocalAfterSnapshot(change: TrackedFileChange): Promise<FileSnapshot> {
  const snapshot = { ...change.after }
  const existingText =
    snapshot.text ??
    (snapshot.size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES ? snapshot.fullText : undefined)
  if (
    existingText !== undefined ||
    change.transport !== 'local' ||
    snapshot.size > INLINE_TEXT_SNAPSHOT_LIMIT_BYTES ||
    !snapshot.hash
  ) {
    return snapshot
  }
  const text = await readLocalTextMatchingHash(
    change.filePath,
    snapshot.hash,
    INLINE_TEXT_SNAPSHOT_LIMIT_BYTES
  )
  return text === null ? snapshot : { ...snapshot, text }
}

async function findChange(
  runId: string,
  changeId: string,
  workspaceId: string
): Promise<{ changeSet: RunChangeSet; change: TrackedFileChange } | null> {
  const changeSet = await loadRunChangeSet(runId, workspaceId)
  if (!changeSet) return null
  const change = changeSet.changes.find((entry) => entry.id === changeId)
  if (!change) return null
  return { changeSet, change }
}

function resolveSnapshotFullText(snapshot: FileSnapshot): string | null {
  if (!snapshot.exists) return ''
  return snapshot.fullText ?? snapshot.text ?? null
}

async function getChangeDiffContent(
  runId: string,
  changeId: string,
  workspaceId: string
): Promise<{ beforeText: string; afterText: string } | { error: string } | null> {
  const found = await findChange(runId, changeId, workspaceId)
  if (!found) return null

  const beforeText = resolveSnapshotFullText(found.change.before)
  let afterText = resolveSnapshotFullText(found.change.after)

  if (afterText === null && found.change.status === 'open') {
    if (found.change.transport === 'local') {
      afterText = await readLocalTextMatchingHash(found.change.filePath, found.change.after.hash)
    } else if (found.change.connectionId && sshChangeAdapter) {
      try {
        const snap = await sshChangeAdapter.readSnapshot(
          found.change.connectionId,
          found.change.filePath
        )
        const snapText = resolveSnapshotFullText(snap)
        if (snapText !== null && hashText(snapText) === found.change.after.hash) {
          afterText = snapText
        }
      } catch {
        // SSH connection may be unavailable
      }
    }
  }

  if (beforeText === null || afterText === null) {
    return { error: 'Full diff is unavailable for this change' }
  }

  return { beforeText, afterText }
}

async function forceRollback(
  change: TrackedFileChange
): Promise<{ reverted: boolean; reason?: string }> {
  if (change.transport === 'local') {
    return await rollbackLocalFileChange(change)
  }

  if (change.op === 'create') {
    if (!change.connectionId || !sshChangeAdapter) {
      return { reverted: false, reason: 'SSH change adapter is unavailable' }
    }
    try {
      await sshChangeAdapter.deleteFile(change.connectionId, change.filePath)
    } catch (err) {
      return { reverted: false, reason: String(err) }
    }

    change.status = 'reverted'
    change.revertedAt = Date.now()
    return { reverted: true }
  }

  const beforeText = resolveSnapshotFullText(change.before)
  if (change.before.exists && beforeText === null) {
    return {
      reverted: false,
      reason: 'Original content was not captured in full (file too large at capture time)'
    }
  }

  const targetText = beforeText ?? ''
  if (!change.connectionId || !sshChangeAdapter) {
    return { reverted: false, reason: 'SSH change adapter is unavailable' }
  }
  try {
    await sshChangeAdapter.writeText(change.connectionId, change.filePath, targetText)
  } catch (err) {
    return { reverted: false, reason: String(err) }
  }

  change.status = 'reverted'
  change.revertedAt = Date.now()
  return { reverted: true }
}

export async function readLocalTextMatchingHash(
  filePath: string,
  expectedHash: string | null,
  maxBytes?: number
): Promise<string | null> {
  if (!expectedHash) return null
  try {
    const content = await readFile(filePath)
    if (maxBytes !== undefined && content.byteLength > maxBytes) return null
    const text = content.toString('utf8')
    return hashText(text) === expectedHash.toLowerCase() ? text : null
  } catch {
    return null
  }
}

export async function rollbackLocalFileChange(
  change: TrackedFileChange
): Promise<{ reverted: boolean; reason?: string }> {
  if (change.status === 'reverted') return { reverted: true }
  try {
    if (change.op === 'create') {
      await rm(change.filePath, { force: true })
    } else {
      const beforeText = resolveSnapshotFullText(change.before)
      if (change.before.exists && beforeText === null) {
        return {
          reverted: false,
          reason: 'Original content was not captured in full (file too large at capture time)'
        }
      }
      await writeFile(change.filePath, beforeText ?? '', 'utf8')
    }
    change.status = 'reverted'
    change.revertedAt = Date.now()
    return { reverted: true }
  } catch (error) {
    return { reverted: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function undoRunChangeSet(
  runId: string,
  workspaceId: string
): Promise<{
  success: boolean
  revertedCount: number
  failureCount: number
  failures: Array<{ changeId: string; filePath: string; reason: string }>
  changeset: RunChangeSet | null
}> {
  const changeSet = await loadRunChangeSet(runId, workspaceId)
  if (!changeSet) {
    return {
      success: false,
      revertedCount: 0,
      failureCount: 0,
      failures: [],
      changeset: null
    }
  }

  let revertedCount = 0
  let failureCount = 0
  const failures: Array<{ changeId: string; filePath: string; reason: string }> = []

  for (const change of [...changeSet.changes].reverse()) {
    if (change.status !== 'open') continue
    const result = await forceRollback(change)
    if (result.reverted) {
      revertedCount += 1
      await markFileChangeReverted({
        runId,
        workspaceId,
        changeId: change.id,
        revertedAt: change.revertedAt ?? Date.now()
      })
    } else {
      failureCount += 1
      failures.push({
        changeId: change.id,
        filePath: change.filePath,
        reason: result.reason ?? 'Unknown error'
      })
    }
  }

  await recomputeRunStatus(runId, workspaceId)
  const refreshed = await loadRunChangeSet(runId, workspaceId)

  return {
    success: failureCount === 0,
    revertedCount,
    failureCount,
    failures,
    changeset: refreshed
  }
}

async function undoFileChange(
  runId: string,
  changeId: string,
  workspaceId: string
): Promise<{
  success: boolean
  reason?: string
  changeset: RunChangeSet | null
}> {
  const found = await findChange(runId, changeId, workspaceId)
  if (!found) {
    return { success: false, reason: 'Change not found', changeset: null }
  }

  if (found.change.status === 'reverted') {
    return { success: true, changeset: found.changeSet }
  }

  const result = await forceRollback(found.change)
  if (result.reverted) {
    await markFileChangeReverted({
      runId,
      workspaceId,
      changeId,
      revertedAt: found.change.revertedAt ?? Date.now()
    })
  }
  await recomputeRunStatus(runId, workspaceId)
  const refreshed = await loadRunChangeSet(runId, workspaceId)

  return {
    success: result.reverted,
    reason: result.reason,
    changeset: refreshed
  }
}

export function registerAgentChangeHandlers(): void {
  registerAgentChangeMessagePackHandler<ListSessionRunChangesArgs>(
    'agent:changes:list-session',
    async (args) => {
      try {
        if (!args?.sessionId) return []
        await requireAgentChangeWorkspace(args.workspaceId, args.sessionId)
        const changeSets = await getRunChangeSetsBySession(args.sessionId, args.workspaceId)
        await requireAgentChangeWorkspace(args.workspaceId, args.sessionId)
        return changeSets
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerAgentChangeMessagePackHandler<{ runId: string; changeId: string; workspaceId: string }>(
    'agent:changes:diff-content',
    async (args) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        await requireRunWorkspace(args.runId, args.workspaceId)
        const diff = await getChangeDiffContent(args.runId, args.changeId, args.workspaceId)
        await requireRunWorkspace(args.runId, args.workspaceId)
        return diff
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerAgentChangeMessagePackHandler<{ runId: string; workspaceId: string }>(
    'agent:changes:undo-run',
    async (args) => {
      try {
        if (!args?.runId) return { error: 'runId is required' }
        await requireRunWorkspace(args.runId, args.workspaceId)
        return await undoRunChangeSet(args.runId, args.workspaceId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerAgentChangeMessagePackHandler<{ runId: string; changeId: string; workspaceId: string }>(
    'agent:changes:undo-file',
    async (args) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        await requireRunWorkspace(args.runId, args.workspaceId)
        return await undoFileChange(args.runId, args.changeId, args.workspaceId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}
