import * as goalsDao from '../db/goals-dao'
import * as sessionsDao from '../db/sessions-dao'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { safeSendMessagePackToWorkspaceWindows } from '../window-ipc'

export const GOAL_UPDATED_CHANNEL = 'goal:updated'
export const GOAL_CLEARED_CHANNEL = 'goal:cleared'
export const GOAL_EVENT_ADDED_CHANNEL = 'goal:event-added'
export const GOAL_RUN_STATE_CHANNEL = 'goal:run-state'
export const GOAL_CONTINUE_REQUESTED_CHANNEL = 'goal:continue-requested'

async function emitGoalEvent(
  channel: string,
  sessionId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const session = await sessionsDao.getSession(sessionId)
    const workspaceId = session?.workspace_id
    if (!workspaceId) return
    if (workspaceId !== 'local-personal') {
      const authorized = await loadOfflineWorkspaceIds()
      if (!authorized.has(workspaceId)) return
    }
    safeSendMessagePackToWorkspaceWindows(workspaceId, channel, { ...payload, workspaceId })
  } catch (error) {
    console.warn('[Goal Sync] Unable to route workspace event:', error)
  }
}

export function emitGoalUpdated(goal: goalsDao.SessionGoalRow, reason: string): void {
  void emitGoalEvent(GOAL_UPDATED_CHANNEL, goal.session_id, { reason, goal })
}

export function emitGoalCleared(sessionId: string, reason: string): void {
  void emitGoalEvent(GOAL_CLEARED_CHANNEL, sessionId, { reason, sessionId })
}

export function emitGoalEventAdded(event: goalsDao.SessionGoalEventRow, reason: string): void {
  void emitGoalEvent(GOAL_EVENT_ADDED_CHANNEL, event.session_id, { reason, event })
}

export function emitGoalRunState(args: {
  sessionId: string
  active: boolean
  goalId?: string | null
  startedAt?: number
  reason: string
}): void {
  void emitGoalEvent(GOAL_RUN_STATE_CHANNEL, args.sessionId, args)
}

export function emitGoalContinueRequested(args: {
  sessionId: string
  goalId?: string | null
  reason: string
}): void {
  void emitGoalEvent(GOAL_CONTINUE_REQUESTED_CHANNEL, args.sessionId, args)
}
