const sessionAbortControllers = new Map<string, AbortController>()
const sessionRunListeners = new Map<string, Set<() => void>>()

function notifySessionRunChange(sessionId: string): void {
  const listeners = sessionRunListeners.get(sessionId)
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}

export function getSessionAbortController(sessionId: string): AbortController | undefined {
  return sessionAbortControllers.get(sessionId)
}

export function hasSessionAbortController(sessionId: string): boolean {
  return sessionAbortControllers.has(sessionId)
}

export function registerSessionAbortController(
  sessionId: string,
  controller: AbortController
): void {
  sessionAbortControllers.set(sessionId, controller)
  notifySessionRunChange(sessionId)
}

export function clearSessionAbortController(sessionId: string, controller: AbortController): void {
  if (sessionAbortControllers.get(sessionId) !== controller) return
  sessionAbortControllers.delete(sessionId)
  notifySessionRunChange(sessionId)
}

/** Wait for the active request loop to leave its finally block before deleting its session. */
export function waitForSessionRunToSettle(sessionId: string, timeoutMs = 30_000): Promise<boolean> {
  if (!sessionAbortControllers.has(sessionId)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const listeners = sessionRunListeners.get(sessionId) ?? new Set<() => void>()
    sessionRunListeners.set(sessionId, listeners)

    const cleanup = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      listeners.delete(check)
      if (listeners.size === 0) sessionRunListeners.delete(sessionId)
    }
    const check = (): void => {
      if (sessionAbortControllers.has(sessionId)) return
      cleanup()
      resolve(true)
    }

    listeners.add(check)
    const timeout = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    check()
  })
}
