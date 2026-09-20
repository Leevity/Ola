import { registerMessagePackHandler } from './messagepack-handler'
import { TeamRuntimeStore } from '../teams/team-runtime-store'
import { getRegisteredWindowWorkspace, getTrustedWorkspaceRegistrationWindow } from '../window-ipc'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../../shared/team-runtime-types'

const teamRuntimeStore = new TeamRuntimeStore()

async function authorizedWorkspace<T extends { workspaceId?: string }>(
  args: T,
  event: IpcMainInvokeEvent
): Promise<string> {
  const workspaceId = args.workspaceId?.trim()
  const window = getTrustedWorkspaceRegistrationWindow(event)
  const registered = window ? getRegisteredWindowWorkspace(window) : undefined
  if (!workspaceId || !registered || registered !== workspaceId)
    throw new Error('TEAM_WORKSPACE_FORBIDDEN')
  if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
    throw new Error('TEAM_WORKSPACE_FORBIDDEN')
  return workspaceId
}

export function registerTeamRuntimeHandlers(): void {
  registerMessagePackHandler<CreateTeamRuntimeArgs>('team-runtime:create', async (args, event) => {
    await authorizedWorkspace(args, event)
    return await teamRuntimeStore.create(args)
  })

  registerMessagePackHandler<DeleteTeamRuntimeArgs>('team-runtime:delete', async (args, event) => {
    await authorizedWorkspace(args, event)
    return await teamRuntimeStore.delete(args)
  })

  registerMessagePackHandler<AppendTeamRuntimeMessageArgs>(
    'team-runtime:message:append',
    async (args, event) => {
      await authorizedWorkspace(args, event)
      return await teamRuntimeStore.appendMessage(args)
    }
  )

  registerMessagePackHandler<GetTeamRuntimeSnapshotArgs>(
    'team-runtime:snapshot',
    async (args, event) => {
      await authorizedWorkspace(args, event)
      return await teamRuntimeStore.snapshot(args)
    }
  )

  registerMessagePackHandler<UpdateTeamRuntimeMemberArgs>(
    'team-runtime:member:update',
    async (args, event) => {
      await authorizedWorkspace(args, event)
      return await teamRuntimeStore.updateMember(args)
    }
  )

  registerMessagePackHandler<UpdateTeamRuntimeManifestArgs>(
    'team-runtime:manifest:update',
    async (args, event) => {
      await authorizedWorkspace(args, event)
      return await teamRuntimeStore.updateManifestPatch(args)
    }
  )

  registerMessagePackHandler<ConsumeTeamRuntimeMessagesArgs>(
    'team-runtime:messages:consume',
    async (args, event) => {
      await authorizedWorkspace(args, event)
      return await teamRuntimeStore.consumeMessages(args)
    }
  )
}
