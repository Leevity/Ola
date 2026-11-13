/**
 * Main authorizes a submitted run against the business session that owns it
 * (`getSession(run.sessionId, run.workspaceId)`), so an auxiliary model request
 * must travel under a session that really exists in the run's workspace. A
 * synthetic id is refused as SESSION_WORKSPACE_MISMATCH before the model is
 * reached, which silently disabled every auxiliary text feature.
 */
export async function resolveAuxiliaryRunSessionId(
  workspaceId: string,
  preferred?: string | null
): Promise<string | null> {
  const explicit = preferred?.trim()
  if (explicit) return explicit

  // The chat store reaches back into the runtime bridge, so it is loaded lazily
  // to keep this module out of that import cycle.
  const { useChatStore } = await import('@renderer/stores/chat-store')
  const state = useChatStore.getState()
  const candidates = state.sessions.filter(
    (session) => (session.workspaceId ?? 'local-personal') === workspaceId
  )
  const active = candidates.find((session) => session.id === state.activeSessionId)
  if (active) return active.id
  const newest = candidates.reduce<(typeof candidates)[number] | null>(
    (best, session) => (!best || session.updatedAt > best.updatedAt ? session : best),
    null
  )
  return newest?.id ?? null
}
