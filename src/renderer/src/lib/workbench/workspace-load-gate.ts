export interface WorkspaceLoadToken {
  workspaceId: string
  revision: number
}

export class WorkspaceLoadGate {
  private revision = 0

  begin(workspaceId: string): WorkspaceLoadToken {
    return { workspaceId, revision: ++this.revision }
  }

  accepts(token: WorkspaceLoadToken, activeWorkspaceId: string): boolean {
    return token.revision === this.revision && token.workspaceId === activeWorkspaceId
  }
}
