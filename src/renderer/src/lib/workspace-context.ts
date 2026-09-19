export const LOCAL_PERSONAL_WORKSPACE_ID = 'local-personal'

export type WorkspaceKind = 'local-personal' | 'ola-personal' | 'ola-team'

export type WorkspaceContext = {
  id: string
  kind: WorkspaceKind
  name: string
  role?: 'owner' | 'team_admin' | 'member'
  revision?: string
}

export type OlaModelResource = {
  id: string
  workspaceId: string
  providerName: string
  model: string
  displayName?: string
  enabled: boolean
  isDefault: boolean
  supportsVision?: boolean
  supportsFunctionCall?: boolean
  category?: 'chat' | 'image' | 'embedding' | 'speech'
  revision?: string
}

export const LOCAL_PERSONAL_WORKSPACE: WorkspaceContext = {
  id: LOCAL_PERSONAL_WORKSPACE_ID,
  kind: 'local-personal',
  name: 'Local workspace',
  role: 'owner'
}

export function isOlaWorkspace(workspace: WorkspaceContext): boolean {
  return workspace.kind === 'ola-personal' || workspace.kind === 'ola-team'
}

export function workspaceProviderId(workspaceId: string): string {
  return `ola-managed:${workspaceId}`
}

export function isOlaManagedProviderId(providerId?: string | null): boolean {
  return Boolean(providerId?.startsWith('ola-managed:'))
}
