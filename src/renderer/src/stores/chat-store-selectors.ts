import type { UnifiedMessage } from '../lib/api/types'
import type { Project, Session } from './chat-store'

export interface ChatSessionState {
  sessions: Session[]
  activeSessionId: string | null
  activeProjectId: string | null
}

export interface ChatMessageState {
  sessions: Session[]
}

export interface ChatStreamingState {
  sessions: Session[]
  streamingMessageId: string | null
  streamingMessages: Record<string, string>
}

export function selectActiveSession(state: ChatSessionState): Session | null {
  if (!state.activeSessionId) return null
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null
}

export function selectSessionById(
  state: Pick<ChatSessionState, 'sessions'>,
  sessionId: string | null | undefined
): Session | null {
  if (!sessionId) return null
  return state.sessions.find((session) => session.id === sessionId) ?? null
}

export function selectSessionMessages(
  state: ChatMessageState,
  sessionId: string | null | undefined
): UnifiedMessage[] {
  return selectSessionById(state, sessionId)?.messages ?? []
}

export function selectStreamingMessage(
  state: ChatStreamingState,
  sessionId: string | null | undefined
): UnifiedMessage | null {
  const messageId = sessionId ? state.streamingMessages[sessionId] : state.streamingMessageId
  if (!messageId) return null
  return selectSessionById(state, sessionId)?.messages.find((message) => message.id === messageId) ?? null
}

export function selectActiveProject(
  state: Pick<ChatSessionState, 'activeProjectId'> & { projects: Project[] }
): Project | null {
  if (!state.activeProjectId) return null
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null
}
