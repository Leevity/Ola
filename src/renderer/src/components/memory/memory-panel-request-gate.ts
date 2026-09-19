export interface MemoryPanelRequestToken {
  scopeKey: string
  workspaceId: string
  revision: number
  requestId: number
}

export class MemoryPanelRequestGate {
  private scopeKey = ''
  private revision = 0
  private requestId = 0

  setScope(scopeKey: string): void {
    if (this.scopeKey === scopeKey) return
    this.scopeKey = scopeKey
    this.revision += 1
  }

  begin(scopeKey: string, workspaceId: string): MemoryPanelRequestToken {
    this.setScope(scopeKey)
    return { scopeKey, workspaceId, revision: this.revision, requestId: ++this.requestId }
  }

  accepts(token: MemoryPanelRequestToken, activeWorkspaceId: string): boolean {
    return (
      this.scopeKey === token.scopeKey &&
      this.revision === token.revision &&
      this.requestId === token.requestId &&
      activeWorkspaceId === token.workspaceId
    )
  }
}
