/** Keeps a window's pending TS run submission ordered against workspace switching. */
export class TsRuntimeWorkspaceAdmission {
  private submissions = 0
  private switching = false

  get hasPendingSubmission(): boolean {
    return this.submissions > 0
  }

  get isSwitching(): boolean {
    return this.switching
  }

  beginSubmission(): () => void {
    if (this.switching) throw new Error('WORKSPACE_BUSY_TS_RUNTIME')
    this.submissions++
    let released = false
    return () => {
      if (released) return
      released = true
      this.submissions--
    }
  }

  beginSwitch(): () => void {
    if (this.switching || this.submissions > 0) throw new Error('WORKSPACE_BUSY_TS_RUNTIME')
    this.switching = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.switching = false
    }
  }
}
