import { BusinessRepository } from '../../runtime/storage/business-repository'
import { businessWriteCanary } from './business-write-canary'
import type { ProjectWikiDocument } from '../../shared/project-wiki'
import type { CronJobRecord, CronRunLogRow, CronRunMessageRow, CronRunRecord } from './cron-dao'
import type { DrawRunRow } from './draw-runs-dao'
import type { SubAgentHistoryPage, SubAgentHistoryRow } from '../../shared/sub-agent-history-types'
import type {
  MemoryAutomationEntry,
  MemoryAutomationListQuery,
  MemoryPipelineListRootsQuery,
  MemoryPipelineListJobsQuery,
  MemoryPipelineJob,
  MemoryRootDescriptor,
  MemoryStage1Output
} from '../../shared/memory-automation-types'
import type {
  LegacyMessageContentMatch,
  LegacyMessageLocatorRow,
  LegacyMessageWindowResult,
  LegacyPluginSessionRow,
  LegacyPluginSessionMessageRow,
  LegacyChannelSessionStatus,
  LegacyChannelSessionUsageStats,
  LegacyProjectRow,
  LegacySessionRow,
  LegacyTaskRow,
  LegacyPlanRow,
  LegacyGoalRow,
  LegacyGoalEventRow,
  LegacyMessageRow,
  LegacyAgentChangeSet
} from '../../runtime/storage/business-read-types'

let repository: BusinessRepository | null = null

function reader(): BusinessRepository {
  const current = businessWriteCanary()
  if (!current) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  return (repository ??= current)
}

// Retain the old adapter predicates as always-on compatibility shims while
// callers are incrementally renamed. They no longer consult environment
// switches and cannot select a legacy reader.
const sessionReadsEnabled = (): boolean => true
const projectReadsEnabled = (): boolean => true
const planReadsEnabled = (): boolean => true
const taskReadsEnabled = (): boolean => true
const messageReadsEnabled = (): boolean => true
const goalReadsEnabled = (): boolean => true
const usageEventReadsEnabled = (): boolean => true
const usageAnalyticsReadsEnabled = (): boolean => true
const channelSessionReadsEnabled = (): boolean => true
const agentChangeReadsEnabled = (): boolean => true
const qqWakeupReadsEnabled = (): boolean => true
const wikiReadsEnabled = (): boolean => true
const desktopFlowReadsEnabled = (): boolean => true
const desktopFlowRunReadsEnabled = (): boolean => true
const drawRunReadsEnabled = (): boolean => true
const subAgentHistoryReadsEnabled = (): boolean => true
const runtimeToolResultReadsEnabled = (): boolean => true
const memoryRootReadsEnabled = (): boolean => true
const cronJobReadsEnabled = (): boolean => true
const cronRunReadsEnabled = (): boolean => true

async function discardFailedReader(): Promise<void> {
  // The repository is shared with TS writes; never close or replace it here.
}

function failReadInProduction(_label: string, error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error))
}

/**
 * Compatibility-shaped adapters for the TS-owned repository. Sessions,
 * projects, plans, tasks, goals, scoped messages, channel sessions, agent changes,
 * usage reads, QQ wakeup eligibility, Project Wiki, and desktop flows are
 * are all served by the same TS BusinessRepository that owns writes. Calls
 * without an explicit workspace fail closed and never reach another reader.
 */
export async function canaryListSessions(args: {
  workspaceId?: string
  limit: number
  offset: number
}): Promise<LegacySessionRow[] | null> {
  if (!sessionReadsEnabled() || !args.workspaceId?.trim()) return null
  try {
    return await reader().sessions(args.workspaceId, args.limit, args.offset)
  } catch (error) {
    await discardFailedReader()
    return failReadInProduction('sessions list', error)
  }
}

export async function canaryGetSession(args: {
  id: string
  workspaceId?: string
}): Promise<LegacySessionRow | null | undefined> {
  if (!sessionReadsEnabled() || !args.workspaceId?.trim()) return undefined
  try {
    return await reader().session(args.id, args.workspaceId)
  } catch (error) {
    await discardFailedReader()
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function canaryListCronJobs(args: {
  workspaceId?: string
  sessionId?: string | null
  includeDeleted?: boolean
}): Promise<CronJobRecord[] | undefined> {
  if (!cronJobReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('cron jobs list', () =>
    reader().cronJobs<CronJobRecord>(args.workspaceId!, {
      includeDeleted: args.includeDeleted,
      limit: 2000,
      offset: 0
    })
  )
}

export async function canaryGetCronJob(args: {
  jobId: string
  workspaceId?: string
}): Promise<CronJobRecord | null | undefined> {
  if (!cronJobReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('cron job get', () =>
    reader().cronJob<CronJobRecord>(args.jobId, args.workspaceId!)
  )
}

export async function canaryListCronRuns(args: {
  workspaceId?: string
  jobId?: string
  sessionId?: string | null
  start?: number
  end?: number
  limit?: number
}): Promise<CronRunRecord[] | undefined> {
  if (!cronRunReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('cron runs list', () =>
    reader().cronRuns<CronRunRecord>(args.workspaceId!, args.limit ?? 200, 0)
  )
}

export async function canaryGetCronRun(args: {
  runId: string
  workspaceId?: string
}): Promise<CronRunRecord | null | undefined> {
  if (!cronRunReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('cron run get', () =>
    reader().cronRun<CronRunRecord>(args.runId, args.workspaceId!)
  )
}

export async function canaryGetCronRunDetail(args: {
  runId: string
  workspaceId?: string
}): Promise<
  | {
      run: CronRunRecord
      job: CronJobRecord | null
      messages: CronRunMessageRow[]
      logs: CronRunLogRow[]
    }
  | null
  | undefined
> {
  if (!cronRunReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('cron run detail', () =>
    reader().cronRunDetail<{
      run: CronRunRecord
      job: CronJobRecord | null
      messages: CronRunMessageRow[]
      logs: CronRunLogRow[]
    }>(args.runId, args.workspaceId!)
  )
}

export async function canaryListUsageEvents<T>(query: {
  workspaceId: string
  from: number
  to: number
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
  limit?: number
  offset?: number
}): Promise<T[] | undefined> {
  if (!usageEventReadsEnabled() || !query.workspaceId.trim()) return undefined
  return await canaryRead('usage events list', () => reader().usageEvents<T>(query))
}

export async function canaryGetUsageOverview<T>(query: {
  workspaceId: string
  from: number
  to: number
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
}): Promise<T | undefined> {
  if (!usageAnalyticsReadsEnabled() || !query.workspaceId.trim()) return undefined
  return await canaryRead('usage overview', () => reader().usageOverview<T>(query))
}

export async function canaryGetRawUsageRows<T>(
  operation: 'daily' | 'timeline' | 'by-model' | 'by-provider',
  query: {
    workspaceId: string
    from: number
    to: number
    providerId?: string | null
    modelId?: string | null
    sourceKind?: string | null
    bucket?: 'hour' | 'day'
  }
): Promise<T[] | undefined> {
  if (!usageAnalyticsReadsEnabled() || !query.workspaceId.trim()) return undefined
  return await canaryRead(`usage ${operation}`, () => reader().usageRawRows<T>(operation, query))
}

export async function canaryGetUsageActivity<T>(
  operation: 'activity-overview' | 'activity-daily' | 'activity-by-model' | 'activity-by-provider',
  query: {
    workspaceId: string
    from: number
    to: number
    limit?: number
    offset?: number
  }
): Promise<{ row?: T; rows?: T[] } | undefined> {
  if (!usageAnalyticsReadsEnabled() || !query.workspaceId.trim()) return undefined
  const dimension = operation.endsWith('by-model')
    ? 'models'
    : operation.endsWith('by-provider')
      ? 'providers'
      : 'daily'
  return await canaryRead(`usage ${operation}`, async () => ({
    rows: await reader().usageActivity<T>({
      workspaceId: query.workspaceId,
      fromDay: new Date(query.from).toISOString().slice(0, 10),
      toDay: new Date(query.to).toISOString().slice(0, 10),
      dimension,
      limit: query.limit,
      offset: query.offset
    })
  }))
}

async function canaryRead<T>(label: string, operation: () => Promise<T>): Promise<T | undefined> {
  void label
  return await operation()
}

export async function canaryGetWikiDocument(
  projectRoot: string,
  workspaceId: string
): Promise<ProjectWikiDocument | null | undefined> {
  if (!wikiReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('project Wiki', () => reader().wikiDocument(projectRoot, workspaceId))
}

export async function canaryResolveQqWakeupEligibility(input: {
  workspaceId: string
  pluginId: string
  openId: string
  now: number
}): Promise<
  | {
      enabled: boolean
      periodKey: string | null
      sourceMessageId: string | null
      sourceTimestamp: number
    }
  | undefined
> {
  if (!qqWakeupReadsEnabled() || !input.workspaceId.trim()) return undefined
  return await canaryRead('QQ wakeup resolve', () => reader().qqWakeupEligibility(input))
}

export async function canaryListDesktopFlows(workspaceId: string): Promise<string[] | undefined> {
  if (!desktopFlowReadsEnabled() || !workspaceId.trim()) return undefined
  return (await canaryRead('desktop flows list', () => reader().desktopFlows(workspaceId))) as
    | string[]
    | undefined
}

export async function canaryListDesktopFlowRuns(
  workspaceId: string,
  limit = 100
): Promise<string[] | undefined> {
  if (!desktopFlowRunReadsEnabled() || !workspaceId.trim()) return undefined
  return (await canaryRead('desktop flow runs list', () =>
    reader().desktopFlowRuns(workspaceId, limit)
  )) as string[] | undefined
}

export async function canaryListDrawRuns(workspaceId: string): Promise<DrawRunRow[] | undefined> {
  if (!drawRunReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('draw runs list', () => reader().drawRuns<DrawRunRow>(workspaceId))
}

export async function canaryIndexSubAgentHistory(
  sessionId: string,
  workspaceId: string,
  limit: number
): Promise<SubAgentHistoryRow[] | undefined> {
  if (!subAgentHistoryReadsEnabled()) return undefined
  return canaryRead('sub-agent history index', () =>
    reader().subAgentHistoryIndex(sessionId, workspaceId, limit)
  ) as Promise<SubAgentHistoryRow[] | undefined>
}

export async function canaryListSubAgentHistory(args: {
  sessionId: string
  workspaceId: string
  limit: number
  offset: number
}): Promise<SubAgentHistoryPage | undefined> {
  if (!subAgentHistoryReadsEnabled()) return undefined
  return canaryRead('sub-agent history list', () => reader().subAgentHistoryPage(args))
}

export async function canaryLookupRuntimeToolResults(args: {
  sessionId: string
  workspaceId: string
  toolUseIds: string[]
}): Promise<unknown[] | undefined> {
  if (!runtimeToolResultReadsEnabled()) return undefined
  return canaryRead('runtime tool results lookup', () =>
    reader().runtimeToolResults(args.sessionId, args.workspaceId, args.toolUseIds)
  )
}

export async function canaryListMemoryRoots(
  query: MemoryPipelineListRootsQuery & { workspaceId: string }
): Promise<MemoryRootDescriptor[] | undefined> {
  if (!memoryRootReadsEnabled() || !query.workspaceId.trim()) return undefined
  return await canaryRead('memory roots list', () => reader().memoryRoots(query.workspaceId))
}

export async function canaryGetMemoryRoot(
  id: string,
  workspaceId: string
): Promise<MemoryRootDescriptor | null | undefined> {
  if (!memoryRootReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('memory root get', () => reader().memoryRoot(id, workspaceId))
}

export async function canaryListMemoryJobs(
  query: MemoryPipelineListJobsQuery & { workspaceId: string }
): Promise<MemoryPipelineJob[] | undefined> {
  if (!memoryRootReadsEnabled() || !query.workspaceId.trim()) return undefined
  return await canaryRead('memory jobs list', () =>
    reader().memoryJobs(query.workspaceId, query.limit)
  )
}

export async function canaryGetMemoryJob(
  id: string,
  workspaceId: string
): Promise<MemoryPipelineJob | null | undefined> {
  if (!memoryRootReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('memory job get', () => reader().memoryJob(id, workspaceId))
}

export async function canaryListMemoryStage1Outputs(args: {
  memoryRootId: string
  workspaceId: string
  limit?: number
}): Promise<MemoryStage1Output[] | undefined> {
  if (!memoryRootReadsEnabled() || !args.workspaceId.trim()) return undefined
  return await canaryRead('memory stage1 list', () =>
    reader().memoryStage1Outputs(args.memoryRootId, args.workspaceId, args.limit)
  )
}

export async function canaryListMemoryAutomationEntries(
  query: MemoryAutomationListQuery & { workspaceId: string }
): Promise<MemoryAutomationEntry[] | undefined> {
  if (!memoryRootReadsEnabled() || !query.workspaceId.trim()) return undefined
  return await canaryRead('memory automation list', () =>
    reader().memoryAutomationEntries(
      query.workspaceId,
      query.limit,
      query.offset,
      query.includeContentSnapshots
    )
  )
}

export async function canaryGetMemoryAutomationEntry(
  id: string,
  workspaceId: string
): Promise<MemoryAutomationEntry | null | undefined> {
  if (!memoryRootReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('memory automation get', () =>
    reader().memoryAutomationEntry(id, workspaceId)
  )
}

export async function canaryListPluginSessions(
  pluginId: string,
  workspaceId: string
): Promise<LegacyPluginSessionRow[] | undefined> {
  if (!channelSessionReadsEnabled() || !pluginId.trim() || !workspaceId.trim()) return undefined
  return await canaryRead('channel sessions list', () =>
    reader().pluginSessions(pluginId, workspaceId)
  )
}

export async function canaryListAllPluginSessions(
  workspaceId: string
): Promise<LegacyPluginSessionRow[] | undefined> {
  if (!channelSessionReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('all channel sessions list', () =>
    reader().allPluginSessions(workspaceId)
  )
}

export async function canaryFindPluginSessionByChat(
  externalChatId: string,
  workspaceId: string
): Promise<LegacyPluginSessionRow | null | undefined> {
  if (!channelSessionReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('channel session chat lookup', () =>
    reader().pluginSessionByChat(externalChatId, workspaceId)
  )
}

export async function canaryListPluginSessionMessages(
  sessionId: string,
  workspaceId: string,
  limit?: number,
  offset?: number
): Promise<LegacyPluginSessionMessageRow[] | undefined> {
  if (!channelSessionReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('channel session messages', () =>
    reader().pluginSessionMessages(sessionId, workspaceId, limit, offset)
  )
}

export async function canaryChannelSessionStatus(
  sessionId: string,
  workspaceId: string
): Promise<LegacyChannelSessionStatus | undefined> {
  if (!channelSessionReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('channel session status', () =>
    reader().channelSessionStatus(sessionId, workspaceId)
  )
}

export async function canaryChannelSessionUsageStats(
  sessionId: string,
  workspaceId: string
): Promise<LegacyChannelSessionUsageStats | undefined> {
  if (!channelSessionReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('channel session usage stats', () =>
    reader().channelSessionUsageStats(sessionId, workspaceId)
  )
}

export async function canaryListProjects(
  workspaceId: string
): Promise<LegacyProjectRow[] | undefined> {
  if (!projectReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('projects list', () => reader().allProjects(workspaceId))
}

export async function canaryGetProject(
  id: string,
  workspaceId: string
): Promise<LegacyProjectRow | null | undefined> {
  if (!projectReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('project get', () => reader().project(id, workspaceId))
}

export async function canaryFindProjectByPlugin(
  pluginId: string,
  workspaceId: string
): Promise<LegacyProjectRow | null | undefined> {
  if (!projectReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('project plugin lookup', () =>
    reader().projectByPlugin(pluginId, workspaceId)
  )
}

export async function canaryListTasks(workspaceId: string): Promise<LegacyTaskRow[] | undefined> {
  if (!taskReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('tasks list', () => reader().allTasks(workspaceId))
}

export async function canaryListTasksBySession(
  sessionId: string,
  workspaceId: string
): Promise<LegacyTaskRow[] | undefined> {
  if (!taskReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('session tasks list', () =>
    reader().allTasksBySession(sessionId, workspaceId)
  )
}

export async function canaryGetTask(
  id: string,
  workspaceId: string
): Promise<LegacyTaskRow | null | undefined> {
  if (!taskReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('task get', () => reader().task(id, workspaceId))
}

export async function canaryListPlans(workspaceId: string): Promise<LegacyPlanRow[] | undefined> {
  if (!planReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('plans list', () => reader().allPlans(workspaceId))
}

export async function canaryGetPlan(
  id: string,
  workspaceId: string
): Promise<LegacyPlanRow | null | undefined> {
  if (!planReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('plan get', () => reader().plan(id, workspaceId))
}

export async function canaryGetPlanBySession(
  sessionId: string,
  workspaceId: string
): Promise<LegacyPlanRow | null | undefined> {
  if (!planReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('session plan get', () => reader().planBySession(sessionId, workspaceId))
}

export async function canaryListGoals(workspaceId: string): Promise<LegacyGoalRow[] | undefined> {
  if (!goalReadsEnabled() || !workspaceId.trim()) return undefined
  return await canaryRead('goals list', () => reader().goals(workspaceId))
}

export async function canaryGetGoal(
  sessionId: string,
  workspaceId?: string
): Promise<LegacyGoalRow | null | undefined> {
  if (!goalReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('goal get', () => reader().goal(sessionId, workspaceId))
}

export async function canaryListGoalEvents(args: {
  sessionId: string
  workspaceId?: string
  goalId?: string | null
  limit?: number
}): Promise<LegacyGoalEventRow[] | undefined> {
  if (!goalReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('goal events list', () =>
    reader().goalEvents(args.sessionId, args.workspaceId!, {
      goalId: args.goalId,
      limit: args.limit
    })
  )
}

export async function canaryGetAgentChangeSet(
  runId: string,
  workspaceId: string
): Promise<LegacyAgentChangeSet | null | undefined> {
  if (!agentChangeReadsEnabled() || !workspaceId.trim()) return undefined
  return (await canaryRead('agent change get', () =>
    reader().agentChangeSet(runId, workspaceId)
  )) as LegacyAgentChangeSet | null | undefined
}

export async function canaryListAgentChangeSetsBySession(
  sessionId: string,
  workspaceId: string
): Promise<LegacyAgentChangeSet[] | undefined> {
  if (!agentChangeReadsEnabled() || !workspaceId.trim()) return undefined
  return (await canaryRead('agent changes list', () =>
    reader().agentChangeSetsBySession(sessionId, workspaceId)
  )) as LegacyAgentChangeSet[] | undefined
}

export async function canaryListMessages(
  sessionId: string,
  workspaceId?: string
): Promise<LegacyMessageRow[] | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('messages list', () => reader().messages(sessionId, workspaceId))
}

export async function canaryListUserMessages(
  sessionId: string,
  workspaceId?: string
): Promise<LegacyMessageRow[] | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('user messages list', () => reader().userMessages(sessionId, workspaceId))
}

export async function canaryListMessageLocatorRows(
  sessionId: string,
  workspaceId?: string
): Promise<LegacyMessageLocatorRow[] | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('message locator list', () =>
    reader().messageLocatorRows(sessionId, workspaceId)
  )
}

export async function canaryListMessagesPage(
  sessionId: string,
  workspaceId: string | undefined,
  limit: number,
  offset: number
): Promise<LegacyMessageRow[] | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('messages page', () =>
    reader().messagesPage(sessionId, workspaceId, limit, offset)
  )
}

export async function canaryListMessageMarkers(
  sessionId: string,
  workspaceId?: string
): Promise<LegacyMessageRow[] | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('message markers list', () =>
    reader().messageMarkers(sessionId, workspaceId)
  )
}

export async function canaryGetMessageCount(
  sessionId: string,
  workspaceId?: string
): Promise<number | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('message count', () => reader().messageCount(sessionId, workspaceId))
}

export async function canaryGetMessagesRequestContext(args: {
  sessionId: string
  workspaceId?: string
  maxMessages: number
  headLimit?: number
}): Promise<LegacyMessageRow[] | undefined> {
  if (!messageReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('messages request context', () =>
    reader().messageRequestContext(
      args.sessionId,
      args.workspaceId!,
      args.maxMessages,
      args.headLimit
    )
  )
}

export async function canaryGetMessagesWindowAround(args: {
  sessionId: string
  workspaceId?: string
  messageId?: string | null
  sortOrder?: number | null
  limit: number
}): Promise<LegacyMessageWindowResult | undefined> {
  if (!messageReadsEnabled() || !args.workspaceId?.trim()) return undefined
  return await canaryRead('messages window around', () =>
    reader().messageWindowAround(args.sessionId, args.workspaceId!, args)
  )
}

export async function canarySearchMessageContent(
  query: string,
  workspaceId?: string,
  limit?: number
): Promise<LegacyMessageContentMatch[] | undefined> {
  if (!messageReadsEnabled() || !workspaceId?.trim()) return undefined
  return await canaryRead('messages search', () =>
    reader().searchMessageContent(query, workspaceId, limit)
  )
}

export async function closeLegacyReadCanary(): Promise<void> {
  // BusinessRepository lifecycle is owned by business-write-canary/database.
}
