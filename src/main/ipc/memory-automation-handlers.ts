import { ipcMain } from 'electron'
import { getRegisteredWindowWorkspace, getTrustedWorkspaceRegistrationWindow } from '../window-ipc'
import { handleMemoryWorkspaceRequest } from './memory-workspace-authorization'
import * as memoryAutomationDao from '../db/memory-automation-dao'
import * as memoryPipelineDao from '../db/memory-pipeline-dao'
import { getSession } from '../db/sessions-dao'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import type {
  MemoryCitationEntry,
  MemoryAutomationListQuery,
  MemoryAutomationRecordInput,
  MemoryAutomationRunRollupArgs,
  MemoryAutomationUndoArgs,
  MemoryPipelineClearRootArgs,
  MemoryPipelineListJobsQuery,
  MemoryPipelineListRootsQuery,
  MemoryPipelineRunArgs,
  MemoryRootInput,
  MemoryStage1OutputInput
} from '../../shared/memory-automation-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

function registerMemoryMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    const window = getTrustedWorkspaceRegistrationWindow(event)
    if (!window) throw new Error('MEMORY_IPC_SENDER_UNTRUSTED')
    const result = await handleMemoryWorkspaceRequest(
      args,
      () => getRegisteredWindowWorkspace(window),
      loadOfflineWorkspaceIds,
      () => handler(args)
    )
    return encodeMessagePackPayload(result)
  })
}

function normalizeListQuery(value: unknown): MemoryAutomationListQuery {
  if (!value || typeof value !== 'object') return {}
  return value as MemoryAutomationListQuery
}

function asObject<T>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T
}

function normalizeRoots(value: unknown): MemoryRootInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemoryRootInput => {
    if (!item || typeof item !== 'object') return false
    const record = item as Partial<MemoryRootInput>
    return (
      (record.scope === 'global' || record.scope === 'project') &&
      typeof record.rootPath === 'string' &&
      record.rootPath.trim().length > 0
    )
  })
}

function normalizeStage1Outputs(value: unknown): MemoryStage1OutputInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemoryStage1OutputInput => {
    if (!item || typeof item !== 'object') return false
    const record = item as Partial<MemoryStage1OutputInput>
    return (
      typeof record.memoryRootId === 'string' &&
      (record.scope === 'global' || record.scope === 'project') &&
      typeof record.sourceSessionId === 'string' &&
      typeof record.rawMemory === 'string' &&
      typeof record.rolloutSummary === 'string' &&
      typeof record.rolloutSlug === 'string' &&
      typeof record.fingerprint === 'string'
    )
  })
}

async function memoryWorkspaceForSession(
  sessionId: string | undefined,
  requested?: string
): Promise<string> {
  if (sessionId?.startsWith('rollup:')) return requested ?? 'local-personal'
  if (!sessionId) {
    if (requested && requested !== 'local-personal')
      throw new Error('A session is required for team memory')
    return 'local-personal'
  }
  const session = await getSession(sessionId)
  if (!session) throw new Error('Memory source session not found')
  if (requested && requested !== session.workspace_id)
    throw new Error('Memory source session belongs to another workspace')
  return session.workspace_id
}

async function assertMemoryWorkspace(workspaceId: string): Promise<void> {
  if (workspaceId === 'local-personal') return
  if (!(await loadOfflineWorkspaceIds()).has(workspaceId))
    throw new Error('Memory workspace is not available')
}

async function assertMemoryRootInWorkspace(rootId: string, workspaceId: string): Promise<void> {
  await assertMemoryWorkspace(workspaceId)
  if (!(await memoryPipelineDao.getMemoryRoot(rootId, workspaceId)))
    throw new Error('Memory root is not available in this workspace')
}

export function registerMemoryAutomationHandlers(): void {
  registerMemoryMessagePackHandler<unknown>('memory-automation:list', async (query) => {
    const normalized = normalizeListQuery(query)
    const workspaceId = normalized.workspaceId ?? 'local-personal'
    await assertMemoryWorkspace(workspaceId)
    return {
      entries: await memoryAutomationDao.listMemoryAutomationEntries({
        ...normalized,
        workspaceId
      })
    }
  })

  registerMemoryMessagePackHandler<MemoryAutomationRecordInput>(
    'memory-automation:record',
    async (input) => {
      try {
        const workspaceId = input.sourceSessionId
          ? await memoryWorkspaceForSession(input.sourceSessionId, input.workspaceId)
          : (input.workspaceId ?? 'local-personal')
        await assertMemoryWorkspace(workspaceId)
        const entry = await memoryAutomationDao.addMemoryAutomationEntry({ ...input, workspaceId })
        return { success: true, entry }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  registerMemoryMessagePackHandler<MemoryAutomationUndoArgs>(
    'memory-automation:undo',
    async (args) => {
      try {
        const workspaceId = args.workspaceId ?? 'local-personal'
        await assertMemoryWorkspace(workspaceId)
        const entry = await memoryAutomationDao.markMemoryAutomationUndo(
          args.id,
          args.status ?? 'undone',
          args.error,
          workspaceId
        )
        if (!entry) {
          return { success: false, error: 'Memory automation entry not found' }
        }
        return { success: true, entry }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  registerMemoryMessagePackHandler<{ sessionId?: string } | undefined>(
    'memory-automation:run-session',
    () => {
      return {
        success: true,
        queued: false
      }
    }
  )

  registerMemoryMessagePackHandler<MemoryAutomationRunRollupArgs>(
    'memory-automation:run-rollup',
    async (args) => {
      try {
        const workspaceId = args.workspaceId ?? 'local-personal'
        await assertMemoryWorkspace(workspaceId)
        if (args.action === 'get-watermark') {
          if (!args.scope || !args.targetPath || !args.sourceDate || !args.contentHash) {
            return { success: false, error: 'Missing rollup watermark fields' }
          }
          return {
            success: true,
            alreadyProcessed: await memoryAutomationDao.hasProcessedRollup({
              workspaceId,
              scope: args.scope,
              targetPath: args.targetPath,
              sourceDate: args.sourceDate,
              contentHash: args.contentHash
            })
          }
        }

        if (args.action === 'mark-watermark') {
          if (!args.scope || !args.targetPath || !args.sourceDate || !args.contentHash) {
            return { success: false, error: 'Missing rollup watermark fields' }
          }
          await memoryAutomationDao.markProcessedRollup({
            workspaceId,
            scope: args.scope,
            target: 'project_memory',
            targetPath: args.targetPath,
            sourceDate: args.sourceDate,
            contentHash: args.contentHash
          })
          return { success: true, alreadyProcessed: true }
        }

        return { success: true, queued: false }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:run', async (rawArgs) => {
    const args = asObject<MemoryPipelineRunArgs>(rawArgs)
    try {
      if (args.action === 'prepare-session') {
        const workspaceId = await memoryWorkspaceForSession(args.sessionId, args.workspaceId)
        await assertMemoryWorkspace(workspaceId)
        const roots = await Promise.all(
          normalizeRoots(args.roots).map((root) =>
            memoryPipelineDao.ensureMemoryRoot({ ...root, workspaceId })
          )
        )
        const job = await memoryPipelineDao.createMemoryJob({
          kind: 'stage1',
          workspaceId,
          status: 'running',
          sourceSessionId: args.sessionId ?? null,
          leaseOwner: args.leaseOwner ?? 'renderer'
        })
        return { success: true, roots, job }
      }

      if (args.action === 'ensure-roots') {
        const workspaceId = await memoryWorkspaceForSession(args.sessionId, args.workspaceId)
        await assertMemoryWorkspace(workspaceId)
        const roots = await Promise.all(
          normalizeRoots(args.roots).map((root) =>
            memoryPipelineDao.ensureMemoryRoot({ ...root, workspaceId })
          )
        )
        return { success: true, roots }
      }

      if (args.action === 'complete-stage1') {
        const workspaceId = await memoryWorkspaceForSession(args.sessionId, args.workspaceId)
        await assertMemoryWorkspace(workspaceId)
        const outputs = normalizeStage1Outputs(args.stage1Outputs)
        for (const output of outputs) {
          if (output.sourceSessionId !== args.sessionId)
            throw new Error('Memory output source session does not match the pipeline session')
          await assertMemoryRootInWorkspace(output.memoryRootId, workspaceId)
        }
        const stage1Outputs = await Promise.all(
          outputs.map((output) => memoryPipelineDao.addStage1Output({ ...output, workspaceId }))
        )
        if (args.jobId && !(await memoryPipelineDao.getMemoryJob(args.jobId, workspaceId)))
          throw new Error('Memory job is not available in this workspace')
        let job = args.jobId
          ? await memoryPipelineDao.finishMemoryJob({
              id: args.jobId,
              workspaceId,
              status:
                args.status ?? (stage1Outputs.length > 0 ? 'succeeded' : 'succeeded_no_output'),
              error: args.error
            })
          : undefined
        if (!job && args.sessionId) {
          job = await memoryPipelineDao.createMemoryJob({
            kind: 'stage1',
            workspaceId,
            status: stage1Outputs.length > 0 ? 'succeeded' : 'succeeded_no_output',
            sourceSessionId: args.sessionId
          })
        }
        return { success: true, stage1Outputs, job }
      }

      if (args.action === 'list-stage1-outputs') {
        if (!args.memoryRootId) {
          return { success: false, error: 'memoryRootId is required' }
        }
        const workspaceId = args.workspaceId ?? 'local-personal'
        await assertMemoryRootInWorkspace(args.memoryRootId, workspaceId)
        return {
          success: true,
          stage1Outputs: await memoryPipelineDao.listStage1Outputs({
            memoryRootId: args.memoryRootId,
            workspaceId,
            limit: args.limit
          })
        }
      }

      if (args.action === 'complete-phase2') {
        const workspaceId = args.sessionId
          ? await memoryWorkspaceForSession(args.sessionId, args.workspaceId)
          : (args.workspaceId ?? 'local-personal')
        await assertMemoryWorkspace(workspaceId)
        const rootId = args.memoryRootId ?? null
        if (rootId) await assertMemoryRootInWorkspace(rootId, workspaceId)
        const job =
          args.jobId && (await memoryPipelineDao.getMemoryJob(args.jobId, workspaceId))
            ? await memoryPipelineDao.finishMemoryJob({
                id: args.jobId,
                workspaceId,
                status: args.status ?? (args.error ? 'failed' : 'succeeded'),
                error: args.error
              })
            : await memoryPipelineDao.createMemoryJob({
                kind: 'phase2',
                workspaceId,
                status: args.status ?? (args.error ? 'failed' : 'succeeded'),
                memoryRootId: rootId,
                sourceSessionId: args.sessionId ?? null
              })
        if (args.error && job) {
          await memoryPipelineDao.finishMemoryJob({
            id: job.id,
            workspaceId,
            status: 'failed',
            error: args.error
          })
        }
        return { success: true, job: job ?? undefined }
      }

      if (args.action === 'record-job') {
        const workspaceId = args.sessionId
          ? await memoryWorkspaceForSession(args.sessionId, args.workspaceId)
          : (args.workspaceId ?? 'local-personal')
        await assertMemoryWorkspace(workspaceId)
        if (args.memoryRootId) await assertMemoryRootInWorkspace(args.memoryRootId, workspaceId)
        const job = await memoryPipelineDao.createMemoryJob({
          kind: args.jobKind ?? 'phase2',
          workspaceId,
          status: args.status ?? 'running',
          memoryRootId: args.memoryRootId ?? null,
          sourceSessionId: args.sessionId ?? null,
          leaseOwner: args.leaseOwner ?? 'renderer'
        })
        return { success: true, job }
      }

      return { success: false, error: 'Unsupported memory pipeline action' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:list-roots', async (rawQuery) => {
    try {
      const query = asObject<MemoryPipelineListRootsQuery>(rawQuery)
      const workspaceId = query.workspaceId ?? 'local-personal'
      await assertMemoryWorkspace(workspaceId)
      return {
        roots: await memoryPipelineDao.listMemoryRoots({ ...query, workspaceId })
      }
    } catch (error) {
      return {
        roots: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:list-jobs', async (rawQuery) => {
    try {
      const query = asObject<MemoryPipelineListJobsQuery>(rawQuery)
      const workspaceId = query.workspaceId ?? 'local-personal'
      await assertMemoryWorkspace(workspaceId)
      return {
        jobs: await memoryPipelineDao.listMemoryJobs({ ...query, workspaceId })
      }
    } catch (error) {
      return {
        jobs: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:clear-root', async (rawArgs) => {
    const args = asObject<MemoryPipelineClearRootArgs>(rawArgs)
    try {
      if (!args.memoryRootId) {
        return { success: false, error: 'memoryRootId is required' }
      }
      await assertMemoryRootInWorkspace(args.memoryRootId, args.workspaceId ?? 'local-personal')
      return {
        success: true,
        ...(await memoryPipelineDao.clearMemoryRoot(args))
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory:record-citation-usage', async (rawEntry) => {
    const entry = asObject<MemoryCitationEntry>(rawEntry)
    try {
      if (
        !entry.memoryRootId ||
        (entry.scope !== 'global' && entry.scope !== 'project') ||
        !entry.path
      ) {
        return { success: false, error: 'Invalid memory citation usage payload' }
      }
      await assertMemoryRootInWorkspace(entry.memoryRootId, entry.workspaceId ?? 'local-personal')
      await memoryPipelineDao.recordCitationUsage(entry)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
