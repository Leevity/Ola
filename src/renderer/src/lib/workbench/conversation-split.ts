export function resolveSplitSessionId(
  activeSessionId: string | null | undefined,
  requestedSessionId: string | null | undefined,
  validSessionIds: ReadonlySet<string>
): string | null {
  if (!requestedSessionId || requestedSessionId === activeSessionId) return null
  return validSessionIds.has(requestedSessionId) ? requestedSessionId : null
}
