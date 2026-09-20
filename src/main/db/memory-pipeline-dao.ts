import { getTsDatabaseRouteGuard } from './business-write-canary'
import { businessWriteCanary } from './business-write-canary'
import {
  canaryGetMemoryRoot,
  canaryListMemoryRoots,
  canaryGetMemoryJob,
  canaryListMemoryJobs,
  canaryListMemoryStage1Outputs
} from './legacy-read-canary'
import type {
  MemoryCitationEntry,
  MemoryJobKind,
  MemoryJobStatus,
  MemoryPipelineJob,
  MemoryPipelineListJobsQuery,
  MemoryPipelineListRootsQuery,
  MemoryRootDescriptor,
  MemoryRootInput,
  MemoryStage1Output,
  MemoryStage1OutputInput
} from '../../shared/memory-automation-types'

interface NativeFindRootResult {
  success: boolean
  root?: MemoryRootDescriptor | null
  error?: string | null
}

interface NativeFindJobResult {
  success: boolean
  job?: MemoryPipelineJob | null
  error?: string | null
}

interface NativeClearRootResult {
  success: boolean
  deletedStage1Outputs: number
  deletedJobs: number
  error?: string | null
}

interface NativeMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

function assertNativeObject<T extends { id?: string }>(value: T, label: string): T {
  if (value && typeof value.id === 'string' && value.id.length > 0) {
    return value
  }
  const error =
    value && typeof (value as { error?: unknown }).error === 'string'
      ? String((value as { error?: unknown }).error)
      : `${label} returned an invalid result`
  throw new Error(error)
}

function assertMutation(result: NativeMutationResult, label: string): void {
  if (!result.success) {
    throw new Error(result.error || label)
  }
}

export async function ensureMemoryRoot(input: MemoryRootInput): Promise<MemoryRootDescriptor> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.ensureMemoryRoot<MemoryRootDescriptor>({
      workspaceId: input.workspaceId ?? 'local-personal',
      scope: input.scope,
      rootPath: input.rootPath,
      transport: input.transport ?? 'local',
      projectId: input.projectId ?? null,
      workingFolder: input.workingFolder ?? null,
      sshConnectionId: input.sshConnectionId ?? null
    })
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryRootDescriptor>(
    'db/memory-roots-ensure',
    input,
    120_000
  )
  return assertNativeObject(result, 'Native memory root ensure failed')
}

export async function getMemoryRoot(
  id: string,
  workspaceId = 'local-personal'
): Promise<MemoryRootDescriptor | null> {
  const canary = await canaryGetMemoryRoot(id, workspaceId)
  if (canary !== undefined) return canary
  const writer = businessWriteCanary()
  if (writer) return writer.memoryRoot<MemoryRootDescriptor>(id, workspaceId)
  const result = await getTsDatabaseRouteGuard().request<NativeFindRootResult>(
    'db/memory-roots-get',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory root get failed')
  }
  return result.root ?? null
}

export async function listMemoryRoots(
  query: MemoryPipelineListRootsQuery = {}
): Promise<MemoryRootDescriptor[]> {
  if (query.workspaceId?.trim()) {
    const canary = await canaryListMemoryRoots({ ...query, workspaceId: query.workspaceId })
    if (canary !== undefined) return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return writer.memoryRoots<MemoryRootDescriptor>(query.workspaceId ?? 'local-personal')
  }
  return getTsDatabaseRouteGuard().request<MemoryRootDescriptor[]>(
    'db/memory-roots-list',
    query,
    120_000
  )
}

export async function createMemoryJob(input: {
  kind: MemoryJobKind
  workspaceId?: string
  status?: MemoryJobStatus
  memoryRootId?: string | null
  sourceSessionId?: string | null
  leaseOwner?: string | null
}): Promise<MemoryPipelineJob> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.createMemoryJob<MemoryPipelineJob>({
      kind: input.kind,
      workspaceId: input.workspaceId ?? 'local-personal',
      status: input.status ?? 'pending',
      memoryRootId: input.memoryRootId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      leaseOwner: input.leaseOwner ?? null
    })
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryPipelineJob>(
    'db/memory-jobs-create',
    input,
    120_000
  )
  return assertNativeObject(result, 'Native memory job create failed')
}

export async function getMemoryJob(
  id: string,
  workspaceId = 'local-personal'
): Promise<MemoryPipelineJob | null> {
  const canary = await canaryGetMemoryJob(id, workspaceId)
  if (canary !== undefined) return canary
  const writer = businessWriteCanary()
  if (writer) return writer.memoryJob<MemoryPipelineJob>(id, workspaceId)
  const result = await getTsDatabaseRouteGuard().request<NativeFindJobResult>(
    'db/memory-jobs-get',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory job get failed')
  }
  return result.job ?? null
}

export async function finishMemoryJob(args: {
  id: string
  workspaceId?: string
  status: MemoryJobStatus
  error?: string | null
}): Promise<MemoryPipelineJob | null> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.finishMemoryJob<MemoryPipelineJob>({
      id: args.id,
      workspaceId: args.workspaceId ?? 'local-personal',
      status: args.status as 'succeeded' | 'succeeded_no_output' | 'skipped' | 'failed',
      error: args.error ?? null
    })
  }
  const result = await getTsDatabaseRouteGuard().request<NativeFindJobResult>(
    'db/memory-jobs-finish',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory job finish failed')
  }
  return result.job ?? null
}

export async function listMemoryJobs(
  query: MemoryPipelineListJobsQuery = {}
): Promise<MemoryPipelineJob[]> {
  if (query.workspaceId?.trim()) {
    const canary = await canaryListMemoryJobs({ ...query, workspaceId: query.workspaceId })
    if (canary !== undefined) return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return writer.memoryJobs<MemoryPipelineJob>(query.workspaceId ?? 'local-personal', query.limit)
  }
  return getTsDatabaseRouteGuard().request<MemoryPipelineJob[]>(
    'db/memory-jobs-list',
    query,
    120_000
  )
}

export async function addStage1Output(input: MemoryStage1OutputInput): Promise<MemoryStage1Output> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.addMemoryStage1Output<MemoryStage1Output>({
      ...input,
      workspaceId: input.workspaceId ?? 'local-personal',
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      status: input.status ?? 'active'
    })
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryStage1Output>(
    'db/memory-stage1-add',
    input,
    120_000
  )
  return assertNativeObject(result, 'Native memory stage1 add failed')
}

export async function listStage1Outputs(args: {
  memoryRootId: string
  workspaceId?: string
  limit?: number
}): Promise<MemoryStage1Output[]> {
  if (args.workspaceId?.trim()) {
    const canary = await canaryListMemoryStage1Outputs({
      ...args,
      workspaceId: args.workspaceId
    })
    if (canary !== undefined) return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return writer.memoryStage1Outputs<MemoryStage1Output>(
      args.memoryRootId,
      args.workspaceId ?? 'local-personal',
      args.limit
    )
  }
  return getTsDatabaseRouteGuard().request<MemoryStage1Output[]>(
    'db/memory-stage1-list',
    args,
    120_000
  )
}

export async function recordCitationUsage(entry: MemoryCitationEntry): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.recordMemoryCitationUsage({
      workspaceId: entry.workspaceId ?? 'local-personal',
      memoryRootId: entry.memoryRootId,
      scope: entry.scope,
      path: entry.path,
      sourceSessionId: entry.sourceSessionId ?? null,
      line: entry.line ?? null,
      citationJson: entry.citationJson ?? null
    })
    return
  }
  const result = await getTsDatabaseRouteGuard().request<NativeMutationResult>(
    'db/memory-citation-record',
    entry,
    120_000
  )
  assertMutation(result, 'Native memory citation usage failed')
}

export async function clearMemoryRoot(args: {
  memoryRootId: string
  workspaceId?: string
  includeJobs?: boolean
}): Promise<{ deletedStage1Outputs: number; deletedJobs: number }> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.clearMemoryRoot({
      memoryRootId: args.memoryRootId,
      workspaceId: args.workspaceId ?? 'local-personal',
      includeJobs: args.includeJobs ?? false
    })
  }
  const result = await getTsDatabaseRouteGuard().request<NativeClearRootResult>(
    'db/memory-root-clear',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory root clear failed')
  }
  return {
    deletedStage1Outputs: result.deletedStage1Outputs,
    deletedJobs: result.deletedJobs
  }
}
