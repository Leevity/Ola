const visibleSessionWindowIds = new Map<string, Set<number>>()

export function setSessionWindowVisibility(
  sessionId: string,
  windowId: number,
  visible: boolean
): void {
  if (visible) {
    let windowIds = visibleSessionWindowIds.get(sessionId)
    if (!windowIds) {
      windowIds = new Set()
      visibleSessionWindowIds.set(sessionId, windowIds)
    }
    windowIds.add(windowId)
    return
  }

  const windowIds = visibleSessionWindowIds.get(sessionId)
  if (!windowIds) return
  windowIds.delete(windowId)
  if (windowIds.size === 0) visibleSessionWindowIds.delete(sessionId)
}

export function getSessionWindowIds(sessionId: string): Set<number> | undefined {
  return visibleSessionWindowIds.get(sessionId)
}

export function forgetSessionWindow(windowId: number): void {
  for (const [sessionId, windowIds] of visibleSessionWindowIds) {
    windowIds.delete(windowId)
    if (windowIds.size === 0) visibleSessionWindowIds.delete(sessionId)
  }
}

export function clearSessionVisibility(): void {
  visibleSessionWindowIds.clear()
}
