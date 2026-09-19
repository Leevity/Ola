import { registerMessagePackHandler } from './messagepack-handler'
import { TeamRuntimeStore } from '../teams/team-runtime-store'
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

export function registerTeamRuntimeHandlers(): void {
  registerMessagePackHandler<CreateTeamRuntimeArgs>('team-runtime:create', async (args) => {
    return await teamRuntimeStore.create(args)
  })

  registerMessagePackHandler<DeleteTeamRuntimeArgs>('team-runtime:delete', async (args) => {
    return await teamRuntimeStore.delete(args)
  })

  registerMessagePackHandler<AppendTeamRuntimeMessageArgs>(
    'team-runtime:message:append',
    async (args) => {
      return await teamRuntimeStore.appendMessage(args)
    }
  )

  registerMessagePackHandler<GetTeamRuntimeSnapshotArgs>('team-runtime:snapshot', async (args) => {
    return await teamRuntimeStore.snapshot(args)
  })

  registerMessagePackHandler<UpdateTeamRuntimeMemberArgs>(
    'team-runtime:member:update',
    async (args) => {
      return await teamRuntimeStore.updateMember(args)
    }
  )

  registerMessagePackHandler<UpdateTeamRuntimeManifestArgs>(
    'team-runtime:manifest:update',
    async (args) => {
      return await teamRuntimeStore.updateManifestPatch(args)
    }
  )

  registerMessagePackHandler<ConsumeTeamRuntimeMessagesArgs>(
    'team-runtime:messages:consume',
    async (args) => {
      return await teamRuntimeStore.consumeMessages(args)
    }
  )
}
