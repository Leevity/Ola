/** Serializes SSH IPC admission against a workspace switch. */
export class SshWorkspaceSwitchGate {
  private requestsInFlight = 0
  private switchPending = false

  beginRequest(): () => void {
    if (this.switchPending) throw new Error('WORKSPACE_BUSY_SSH')
    this.requestsInFlight++
    let released = false
    return () => {
      if (released) return
      released = true
      this.requestsInFlight--
    }
  }

  beginSwitch(hasActivity: () => boolean): () => void {
    if (this.switchPending || this.requestsInFlight > 0 || hasActivity())
      throw new Error('WORKSPACE_BUSY_SSH')
    this.switchPending = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.switchPending = false
    }
  }
}
