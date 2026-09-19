let activeTasks = 0
let workspaceSwitching = false

export function hasActiveChannelTasks(): boolean {
  return activeTasks > 0
}

export function isChannelTaskWorkspaceSwitching(): boolean {
  return workspaceSwitching
}

/** A queued task is active from dispatch until its completion or failure. */
export function beginChannelTaskActivity(): (() => void) | null {
  if (workspaceSwitching) return null
  activeTasks++
  let released = false
  return () => {
    if (released) return
    released = true
    activeTasks--
  }
}

/** Keep new channel tasks deferred while an asynchronous workspace switch is in progress. */
export function beginChannelTaskWorkspaceSwitch(): (() => void) | null {
  if (workspaceSwitching || activeTasks > 0) return null
  workspaceSwitching = true
  let released = false
  return () => {
    if (released) return
    released = true
    workspaceSwitching = false
  }
}
