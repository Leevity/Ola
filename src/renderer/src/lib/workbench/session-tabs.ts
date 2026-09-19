export const MAX_WORKBENCH_SESSION_TABS = 20

export function normalizeSessionTabIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of value) {
    if (typeof id !== 'string' || !id || id.length > 256 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids.slice(-MAX_WORKBENCH_SESSION_TABS)
}

export function openSessionTab(tabs: unknown, sessionId: string): string[] {
  const current = normalizeSessionTabIds(tabs)
  if (!sessionId || sessionId.length > 256 || current.includes(sessionId)) return current
  return [...current, sessionId].slice(-MAX_WORKBENCH_SESSION_TABS)
}

export function reorderSessionTab(
  tabs: unknown,
  sessionId: string,
  targetSessionId: string
): string[] {
  const current = normalizeSessionTabIds(tabs)
  const from = current.indexOf(sessionId)
  const target = current.indexOf(targetSessionId)
  if (from < 0 || target < 0 || from === target) return current
  const next = [...current]
  next.splice(from, 1)
  next.splice(next.indexOf(targetSessionId), 0, sessionId)
  return next
}

export function closeSessionTab(
  tabs: unknown,
  sessionId: string,
  activeSessionId: string | null
): { tabs: string[]; nextSessionId: string | null } {
  const current = normalizeSessionTabIds(tabs)
  const index = current.indexOf(sessionId)
  if (index < 0) return { tabs: current, nextSessionId: activeSessionId }
  const next = current.filter((id) => id !== sessionId)
  if (activeSessionId !== sessionId) return { tabs: next, nextSessionId: activeSessionId }
  return { tabs: next, nextSessionId: next[index] ?? next[index - 1] ?? null }
}

export function pruneSessionTabs(tabs: unknown, validSessionIds: ReadonlySet<string>): string[] {
  return normalizeSessionTabIds(tabs).filter((id) => validSessionIds.has(id))
}

export function normalizeSessionTabScopes(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, tabs]) => {
      if (!key.startsWith('window:') || key.length > 2048) return []
      const normalized = normalizeSessionTabIds(tabs)
      return normalized.length ? [[key, normalized]] : []
    })
  )
}
