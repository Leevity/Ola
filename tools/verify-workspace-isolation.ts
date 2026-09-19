import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (file: string): string => readFileSync(resolve(root, file), 'utf8')
const requireText = (file: string, text: string): void => {
  if (!read(file).includes(text)) throw new Error(`${file} must contain ${text}`)
}
const forbidText = (file: string, text: string): void => {
  if (read(file).includes(text)) throw new Error(`${file} must not contain ${text}`)
}

requireText('src/renderer/src/stores/workspace-store.ts', "name: 'ola.workspace-context.v1'")
forbidText('src/renderer/src/stores/workspace-store.ts', 'apiKey')
forbidText('src/renderer/src/stores/workspace-store.ts', 'accessToken')
requireText('src/renderer/src/stores/remote-account-store.ts', "'workspace-list'")
requireText('src/renderer/src/stores/remote-account-store.ts', "'workspace-model-resources'")
forbidText('src/renderer/src/stores/remote-account-store.ts', 'syncModelConfig')
requireText('src/main/remote/account-client.ts', "'/api/account/workspaces'")
requireText('src/renderer/src/stores/chat-store.ts', 'workspaceId: activeWorkspaceId')
requireText('src/renderer/src/stores/chat-store.ts', 'dbClearAllSessions(workspaceId, ids)')
forbidText('src/renderer/src/stores/chat-store.ts', 'agentState.clearToolCalls()')
requireText('src/renderer/src/components/layout/WorkspaceSidebar.tsx', 'ola-workspace-switcher')
requireText('src/renderer/src/components/chat/ChatHomePage.tsx', 'activeWorkspaceId')
requireText(
  'sidecars/Ola.Native.Worker/Modules/Db/DbSessionTools.cs',
  'workspace_id = $workspaceId'
)
requireText(
  'sidecars/Ola.Native.Worker/Modules/Db/DbSessionTools.cs',
  'The selected project is not available in this workspace.'
)
requireText('sidecars/Ola.Native.Worker/Modules/Db/DbProjectTools.cs', 'WorkspaceId = workspaceId')
requireText(
  'sidecars/Ola.Native.Worker/Modules/Db/DbSchemaMigrator.cs',
  'idx_sessions_workspace_updated'
)
requireText(
  'sidecars/Ola.Native.Worker/Modules/Db/DbSchemaMigrator.cs',
  'idx_projects_workspace_updated'
)

console.log('Workspace isolation verification passed')
