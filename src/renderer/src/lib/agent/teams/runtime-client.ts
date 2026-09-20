import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  TeamRuntimeCreateResult,
  TeamRuntimeMessageRecord,
  TeamRuntimeSnapshot,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../../../../../shared/team-runtime-types'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

function scoped<T extends { teamName: string }>(args: T): T & { workspaceId: string } {
  return { ...args, workspaceId: useWorkspaceStore.getState().activeWorkspaceId }
}

export function getActiveTeamWorkspaceId(): string {
  return useWorkspaceStore.getState().activeWorkspaceId
}

export async function createTeamRuntime(
  args: CreateTeamRuntimeArgs
): Promise<TeamRuntimeCreateResult> {
  return window.api.teamRuntimeCreate(scoped(args))
}

export async function deleteTeamRuntime(args: DeleteTeamRuntimeArgs): Promise<{ success: true }> {
  return window.api.teamRuntimeDelete(scoped(args))
}

export async function appendTeamRuntimeMessage(
  args: AppendTeamRuntimeMessageArgs
): Promise<{ success: true }> {
  return window.api.teamRuntimeAppendMessage(scoped(args))
}

export async function getTeamRuntimeSnapshot(
  args: GetTeamRuntimeSnapshotArgs
): Promise<TeamRuntimeSnapshot | null> {
  return window.api.teamRuntimeGetSnapshot(scoped(args))
}

export async function updateTeamRuntimeMember(
  args: UpdateTeamRuntimeMemberArgs
): Promise<{ success: true }> {
  return window.api.teamRuntimeUpdateMember(scoped(args))
}

export async function updateTeamRuntimeManifest(
  args: UpdateTeamRuntimeManifestArgs
): Promise<{ success: true }> {
  return window.api.teamRuntimeUpdateManifest(scoped(args))
}

export async function consumeTeamRuntimeMessages(
  args: ConsumeTeamRuntimeMessagesArgs
): Promise<TeamRuntimeMessageRecord[]> {
  return window.api.teamRuntimeConsumeMessages(scoped(args))
}
