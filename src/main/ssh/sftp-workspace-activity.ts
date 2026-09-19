export interface SftpConnectTicket {
  windowId: number
  connectionId: string
  workspaceId: string
  epoch: number
}

interface ConnectionActivity {
  workspaceId: string
  epoch: number
  pending: number
  connected: boolean
}

/** Tracks UI-owned SFTP links, including a connect still awaiting the Native Worker. */
export class SftpWorkspaceActivity {
  private readonly byWindow = new Map<number, Map<string, ConnectionActivity>>()
  private nextEpoch = 0

  private key(workspaceId: string, connectionId: string): string {
    return JSON.stringify([workspaceId, connectionId])
  }

  beginConnect(
    windowId: number,
    connectionId: string,
    workspaceId = 'local-personal'
  ): SftpConnectTicket {
    if (!Number.isSafeInteger(windowId) || windowId < 1 || !connectionId.trim())
      throw new Error('Invalid SFTP activity owner')
    let connections = this.byWindow.get(windowId)
    if (!connections) {
      connections = new Map()
      this.byWindow.set(windowId, connections)
    }
    const key = this.key(workspaceId, connectionId)
    let activity = connections.get(key)
    if (!activity) {
      activity = { workspaceId, epoch: ++this.nextEpoch, pending: 0, connected: false }
      connections.set(key, activity)
    }
    activity.pending += 1
    return { windowId, connectionId, workspaceId, epoch: activity.epoch }
  }

  finishConnect(ticket: SftpConnectTicket, succeeded: boolean): void {
    const connections = this.byWindow.get(ticket.windowId)
    const key = this.key(ticket.workspaceId, ticket.connectionId)
    const activity = connections?.get(key)
    if (!activity || activity.epoch !== ticket.epoch) return
    activity.pending = Math.max(0, activity.pending - 1)
    if (succeeded) activity.connected = true
    if (!activity.connected && activity.pending === 0) {
      connections?.delete(key)
      if (connections?.size === 0) this.byWindow.delete(ticket.windowId)
    }
  }

  disconnect(windowId: number, connectionId: string, workspaceId = 'local-personal'): void {
    const connections = this.byWindow.get(windowId)
    connections?.delete(this.key(workspaceId, connectionId))
    if (connections?.size === 0) this.byWindow.delete(windowId)
  }

  forgetConnection(connectionId: string, workspaceId = 'local-personal'): void {
    for (const [windowId, connections] of this.byWindow) {
      connections.delete(this.key(workspaceId, connectionId))
      if (connections.size === 0) this.byWindow.delete(windowId)
    }
  }

  forgetManagedWorkspaces(): void {
    this.forgetUnavailableWorkspaces(new Set())
  }

  forgetUnavailableWorkspaces(availableIds: ReadonlySet<string>): void {
    for (const [windowId, connections] of this.byWindow) {
      for (const [key, activity] of connections) {
        if (activity.workspaceId !== 'local-personal' && !availableIds.has(activity.workspaceId))
          connections.delete(key)
      }
      if (connections.size === 0) this.byWindow.delete(windowId)
    }
  }

  hasActivity(isWindowOpen: (windowId: number) => boolean): boolean {
    for (const windowId of this.byWindow.keys()) {
      if (!isWindowOpen(windowId)) this.byWindow.delete(windowId)
    }
    return this.byWindow.size > 0
  }
}
