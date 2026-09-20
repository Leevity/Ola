import { registerMessagePackHandler } from './messagepack-handler'
import { businessWriteCanary } from '../db/business-write-canary'
import { getRegisteredWindowWorkspace, getTrustedWorkspaceRegistrationWindow } from '../window-ipc'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { authorizeDbWorkspace } from './db-workspace-authorization'
import type { BusinessRuntimeJobInput } from '../../runtime/storage/business-repository'

type JobRequest = { workspaceId: string }

async function requireWorkspace(event: unknown, rawWorkspaceId: unknown): Promise<string> {
  const win = getTrustedWorkspaceRegistrationWindow(
    event as Parameters<typeof getTrustedWorkspaceRegistrationWindow>[0]
  )
  if (!win) throw new Error('runtime-job-window-untrusted')
  const workspaceId = await authorizeDbWorkspace(rawWorkspaceId, loadOfflineWorkspaceIds)
  if (getRegisteredWindowWorkspace(win) !== workspaceId)
    throw new Error('runtime-job-window-workspace-mismatch')
  return workspaceId
}

function requireTrustedWindow(event: unknown): void {
  const win = getTrustedWorkspaceRegistrationWindow(
    event as Parameters<typeof getTrustedWorkspaceRegistrationWindow>[0]
  )
  if (!win) throw new Error('runtime-job-window-untrusted')
}

function repository() {
  const value = businessWriteCanary()
  if (!value) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  return value
}

export function registerRuntimeJobHandlers(): void {
  registerMessagePackHandler<BusinessRuntimeJobInput>(
    'runtime:jobs-submit',
    async (args, event) => {
      const workspaceId = await requireWorkspace(event, args.workspaceId)
      return await repository().submitRuntimeJob({ ...args, workspaceId })
    }
  )

  registerMessagePackHandler<JobRequest & { jobId: string }>(
    'runtime:jobs-get',
    async (args, event) => {
      const workspaceId = await requireWorkspace(event, args.workspaceId)
      return await repository().runtimeJob(args.jobId, workspaceId)
    }
  )

  registerMessagePackHandler<JobRequest & { limit?: number }>(
    'runtime:jobs-list',
    async (args, event) => {
      const workspaceId = await requireWorkspace(event, args.workspaceId)
      return await repository().runtimeJobs(workspaceId, args.limit)
    }
  )

  registerMessagePackHandler<
    JobRequest & {
      jobId: string
      state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
      updatedAt: number
      errorCode?: string | null
      errorMessage?: string | null
    }
  >('runtime:jobs-state', async (args, event) => {
    const workspaceId = await requireWorkspace(event, args.workspaceId)
    return await repository().setRuntimeJobState({ ...args, workspaceId })
  })

  registerMessagePackHandler<JobRequest & { jobId: string; updatedAt: number }>(
    'runtime:jobs-cancel',
    async (args, event) => {
      const workspaceId = await requireWorkspace(event, args.workspaceId)
      return await repository().cancelRuntimeJob(args.jobId, workspaceId, args.updatedAt)
    }
  )

  registerMessagePackHandler<JobRequest & { jobId: string; afterSeq?: number; limit?: number }>(
    'runtime:jobs-events',
    async (args, event) => {
      const workspaceId = await requireWorkspace(event, args.workspaceId)
      return await repository().runtimeJobEvents(args.jobId, workspaceId, args.afterSeq, args.limit)
    }
  )

  registerMessagePackHandler<{ now: number; maxAgeMs?: number }>(
    'runtime:jobs-reap-stale',
    async (args, event) => {
      requireTrustedWindow(event)
      return await repository().reapStaleRuntimeJobs(args.now, args.maxAgeMs)
    }
  )
}
