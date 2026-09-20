import { appendTeamRuntimeMessage, getActiveTeamWorkspaceId } from './runtime-client'
import { useTeamStore } from '@renderer/stores/team-store'
import { cancelTsRuntimeRun } from '@renderer/lib/ipc/ts-runtime-bridge'

const pendingShutdownRequests = new Set<string>()

export function requestTeammateShutdown(memberId: string): void {
  pendingShutdownRequests.add(memberId)
}

export async function abortTeammate(memberIdOrName: string): Promise<boolean> {
  const team = useTeamStore.getState().activeTeam
  const member = team?.members.find(
    (item) => item.id === memberIdOrName || item.name === memberIdOrName
  )
  if (
    !team ||
    !member ||
    member.role === 'lead' ||
    member.status === 'stopped' ||
    member.status === 'completed' ||
    member.status === 'failed' ||
    pendingShutdownRequests.has(member.id)
  ) {
    return false
  }

  pendingShutdownRequests.add(member.id)
  try {
    await appendTeamRuntimeMessage({
      teamName: team.name,
      message: {
        id: `shutdown-${member.id}-${Date.now()}`,
        from: 'lead',
        to: member.name,
        type: 'shutdown_request',
        content: JSON.stringify({ memberId: member.id }),
        summary: 'Leader requested teammate shutdown',
        timestamp: Date.now()
      }
    })
    if (member.runId) {
      await cancelTsRuntimeRun({
        workspaceId: getActiveTeamWorkspaceId(),
        runId: member.runId
      })
    }
    return true
  } finally {
    pendingShutdownRequests.delete(member.id)
  }
}

export async function abortAllTeammates(): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team) return
  await Promise.all(
    team.members
      .filter(
        (member) =>
          member.role !== 'lead' &&
          member.status !== 'stopped' &&
          member.status !== 'completed' &&
          member.status !== 'failed'
      )
      .map((member) => abortTeammate(member.id))
  )
}

export function isTeammateRunning(_memberIdOrName: string): boolean {
  const member = useTeamStore
    .getState()
    .activeTeam?.members.find(
      (item) => item.id === _memberIdOrName || item.name === _memberIdOrName
    )
  return Boolean(member?.runId && member.status === 'working')
}
