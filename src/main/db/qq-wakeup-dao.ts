import { getTsDatabaseRouteGuard } from './business-write-canary'
import { authorizeChannelSessionWorkspace } from '../channels/channel-session-workspace'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { canaryResolveQqWakeupEligibility } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface QqWakeupEligibility {
  enabled: boolean
  periodKey: string | null
  sourceMessageId: string | null
  sourceTimestamp: number
}

interface QqWakeupEligibilityResult extends QqWakeupEligibility {
  success: boolean
  error?: string | null
}

interface QqWakeupMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

export async function recordQqWakeupSource(args: {
  pluginId: string
  openId: string
  workspaceId: string
  sourceMessageId: string
  sourceTimestamp: number
  now?: number
}): Promise<void> {
  const workspaceId = await authorizeChannelSessionWorkspace(
    args.workspaceId,
    loadOfflineWorkspaceIds
  )
  const writer = businessWriteCanary()
  if (writer) {
    await writer.recordQqWakeupSource({
      ...args,
      workspaceId,
      now: args.now ?? Date.now()
    })
    return
  }
  const result = await getTsDatabaseRouteGuard().request<QqWakeupMutationResult>(
    'db/qq-wakeup-record-source',
    { ...args, workspaceId, now: args.now ?? Date.now() },
    120_000
  )
  if (!result.success) throw new Error(result.error || 'Native QQ wakeup source recording failed')
}

export async function resolveQqWakeupEligibility(
  pluginId: string,
  openId: string,
  rawWorkspaceId: unknown,
  now = Date.now()
): Promise<QqWakeupEligibility> {
  const workspaceId = await authorizeChannelSessionWorkspace(
    rawWorkspaceId,
    loadOfflineWorkspaceIds
  )
  const writer = businessWriteCanary()
  if (writer) {
    const result = await writer.resolveQqWakeupEligibility({
      pluginId,
      openId,
      workspaceId,
      now
    })
    await authorizeChannelSessionWorkspace(workspaceId, loadOfflineWorkspaceIds)
    return result
  }
  const canary = await canaryResolveQqWakeupEligibility({ pluginId, openId, workspaceId, now })
  if (canary) {
    await authorizeChannelSessionWorkspace(workspaceId, loadOfflineWorkspaceIds)
    return canary
  }
  console.log('[QqWakeup][Native] resolve start', { pluginId })
  const result = await getTsDatabaseRouteGuard().request<QqWakeupEligibilityResult>(
    'db/qq-wakeup-resolve',
    { pluginId, openId, workspaceId, now },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native QQ wakeup resolve failed')
  }
  await authorizeChannelSessionWorkspace(workspaceId, loadOfflineWorkspaceIds)
  console.log('[QqWakeup][Native] resolve done', {
    pluginId,
    enabled: result.enabled,
    periodKey: result.periodKey
  })
  return {
    enabled: result.enabled,
    periodKey: result.periodKey ?? null,
    sourceMessageId: result.sourceMessageId ?? null,
    sourceTimestamp: result.sourceTimestamp
  }
}

export async function markQqWakeupSent(args: {
  pluginId: string
  openId: string
  workspaceId: string
  periodKey: string
  sourceMessageId: string | null
  sourceTimestamp: number
  now?: number
}): Promise<void> {
  const workspaceId = await authorizeChannelSessionWorkspace(
    args.workspaceId,
    loadOfflineWorkspaceIds
  )
  const writer = businessWriteCanary()
  if (writer) {
    await writer.markQqWakeupSent({
      ...args,
      workspaceId,
      now: args.now ?? Date.now()
    })
    return
  }
  console.log('[QqWakeup][Native] mark sent start', {
    pluginId: args.pluginId,
    periodKey: args.periodKey
  })
  const result = await getTsDatabaseRouteGuard().request<QqWakeupMutationResult>(
    'db/qq-wakeup-mark-sent',
    { ...args, workspaceId, now: args.now ?? Date.now() },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native QQ wakeup mark sent failed')
  }
  console.log('[QqWakeup][Native] mark sent done', {
    pluginId: args.pluginId,
    changed: result.changed
  })
}
