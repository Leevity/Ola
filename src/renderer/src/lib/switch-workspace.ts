import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useCronStore } from '@renderer/stores/cron-store'
import { getActiveDrawRunIds, useDrawStore } from '@renderer/stores/draw-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  isTsRuntimeAvailable,
  requestTsRuntimeWorkspaceSwitch
} from '@renderer/lib/ipc/ts-runtime-bridge'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { reattachActiveTsRuntimeRuns } from '@renderer/lib/agent/runtime-reattach'
import {
  canSwitchToKnownWorkspace,
  hasActiveSshWorkspaceActivity
} from '@renderer/lib/workspace-switch-eligibility'
import { beginChannelTaskWorkspaceSwitch } from '@renderer/lib/channel/channel-task-activity'

let workspaceSwitchInFlight = false

export async function switchWorkspace(workspaceId: string): Promise<boolean> {
  if (workspaceSwitchInFlight) return false
  workspaceSwitchInFlight = true
  try {
    return await performWorkspaceSwitch(workspaceId)
  } finally {
    workspaceSwitchInFlight = false
  }
}

async function performWorkspaceSwitch(workspaceId: string): Promise<boolean> {
  const workspace = useWorkspaceStore.getState()
  if (workspaceId === workspace.activeWorkspaceId) return true
  // Do not ask the runtime to switch to a workspace that the current account
  // directory has already removed. Main/Runtime still performs the authority
  // check, but this prevents a stale renderer action from splitting UI state.
  if (
    !canSwitchToKnownWorkspace(
      workspaceId,
      workspace.activeWorkspaceId,
      workspace.getWorkspaces().map((candidate) => candidate.id)
    )
  )
    return false
  const agent = useAgentStore.getState()
  const chat = useChatStore.getState()
  if (
    agent.isRunning ||
    Object.values(agent.runningSessions).some(
      (status) => !['completed', 'failed', 'cancelled', 'idle'].includes(status)
    ) ||
    agent.runningSubAgentSessionIdsSig ||
    Object.values(agent.backgroundProcesses).some((process) => process.status === 'running') ||
    Object.values(agent.sessionBackgroundProcessSummaries).some((processes) =>
      processes.some((process) => process.status === 'running')
    ) ||
    Object.keys(chat.streamingMessages).length > 0 ||
    useTeamStore.getState().activeTeam ||
    hasActiveSshWorkspaceActivity(useSshStore.getState()) ||
    getActiveDrawRunIds().size > 0 ||
    useCronStore.getState().jobs.some((job) => job.executing)
  )
    return false
  const releaseChannelTaskSwitch = beginChannelTaskWorkspaceSwitch()
  if (!releaseChannelTaskSwitch) return false
  try {
    try {
      const desktopFlowActivity = await ipcClient.invoke('desktop-flow:activity', {
        workspaceId: workspace.activeWorkspaceId
      })
      if (
        !desktopFlowActivity ||
        typeof desktopFlowActivity !== 'object' ||
        (desktopFlowActivity as { busy?: boolean }).busy !== false
      )
        return false
    } catch {
      return false
    }
    try {
      const sshActivity = await ipcClient.invoke(IPC.SSH_WORKSPACE_ACTIVITY)
      if (
        !sshActivity ||
        typeof sshActivity !== 'object' ||
        (sshActivity as { busy?: boolean }).busy !== false
      )
        return false
    } catch {
      return false
    }
    try {
      const activity = await ipcClient.invoke('ts-runtime:workspace-activity', {
        workspaceId: workspace.activeWorkspaceId
      })
      if (
        !activity ||
        typeof activity !== 'object' ||
        (activity as { busy?: boolean }).busy !== false
      )
        return false
    } catch {
      return false
    }
    if (
      useWorkspaceStore.getState().activeWorkspaceId !== workspace.activeWorkspaceId ||
      !canSwitchToKnownWorkspace(
        workspaceId,
        workspace.activeWorkspaceId,
        useWorkspaceStore
          .getState()
          .getWorkspaces()
          .map((candidate) => candidate.id)
      )
    )
      return false
    // The service is the authority for persisted TS runs. It closes the gap where
    // another window is unaware of a background run; legacy-only startup retains
    // the established local guard until the service becomes available.
    if (await isTsRuntimeAvailable()) {
      try {
        await requestTsRuntimeWorkspaceSwitch(workspaceId, workspace.activeWorkspaceId)
      } catch {
        return false
      }
    }
    if (
      useWorkspaceStore.getState().activeWorkspaceId !== workspace.activeWorkspaceId ||
      !canSwitchToKnownWorkspace(
        workspaceId,
        workspace.activeWorkspaceId,
        useWorkspaceStore
          .getState()
          .getWorkspaces()
          .map((candidate) => candidate.id)
      )
    )
      return false
    const previousWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
    useUIStore.getState().saveWorkspaceLayout(previousWorkspaceId)
    useWorkspaceStore.getState().setActiveWorkspace(workspaceId)
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return false
    useUIStore.getState().restoreWorkspaceLayout(workspaceId)
    useSshStore.getState().resetForWorkspace()
    useChannelStore.getState().resetForWorkspace()
    void useChannelStore.getState().loadChannels()
    void useSshStore.getState().loadAll()
    useDrawStore.getState().commitRuns([])
    // A successful switch must also attach persisted TS runs that were started
    // from another window. This read-only reattach never starts a second run.
    void reattachActiveTsRuntimeRuns(workspaceId).catch(() => undefined)
    chat.setActiveSession(null)
    chat.setActiveProject(null)
    chat.setActiveProjectHome(null)
    useUIStore.getState().navigateToHome()
    return true
  } finally {
    releaseChannelTaskSwitch()
  }
}
