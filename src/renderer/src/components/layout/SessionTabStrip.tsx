import { useCallback, useEffect, useMemo, type KeyboardEvent } from 'react'
import { Home, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { openSessionOrFocusDetached } from '@renderer/lib/session-window'
import { workspaceLayoutStorageKey } from '@renderer/lib/workbench/workspace-layout'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

const EMPTY_SESSION_TABS: string[] = []

export function SessionTabStrip(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const sessions = useChatStore((state) => state.sessions)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const chatView = useUIStore((state) => state.chatView)
  const scopeKey = workspaceLayoutStorageKey(workspaceId)
  const storedIds = useUIStore(
    (state) => state.sessionTabsByWorkspace[scopeKey] ?? EMPTY_SESSION_TABS
  )
  const openTab = useUIStore((state) => state.openWorkspaceSessionTab)
  const reorderTab = useUIStore((state) => state.reorderWorkspaceSessionTab)
  const closeTab = useUIStore((state) => state.closeWorkspaceSessionTab)
  const scopedSessions = useMemo(
    () =>
      new Map(
        sessions
          .filter((session) => (session.workspaceId ?? 'local-personal') === workspaceId)
          .map((session) => [session.id, session])
      ),
    [sessions, workspaceId]
  )
  const tabIds = storedIds.filter((id) => scopedSessions.has(id))

  useEffect(() => {
    if (chatView !== 'session' || !activeSessionId || !scopedSessions.has(activeSessionId)) return
    openTab(workspaceId, activeSessionId)
  }, [activeSessionId, chatView, openTab, scopedSessions, workspaceId])

  const closeSession = useCallback(
    (sessionId: string): void => {
      const nextId = closeTab(workspaceId, sessionId, activeSessionId)
      if (activeSessionId !== sessionId) return
      useChatStore.getState().setActiveSession(null)
      useUIStore.getState().navigateToHome()
      if (nextId && scopedSessions.has(nextId)) {
        void openSessionOrFocusDetached(nextId)
      }
    },
    [activeSessionId, closeTab, scopedSessions, workspaceId]
  )

  const handleTabKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    next.focus()
    next.click()
  }

  const handleTabReorderKeys = (
    event: KeyboardEvent<HTMLButtonElement>,
    sessionId: string
  ): void => {
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const index = tabIds.indexOf(sessionId)
    const targetIndex = index + (event.key === 'ArrowLeft' ? -1 : 1)
    const targetId = tabIds[targetIndex]
    if (!targetId) return
    event.preventDefault()
    event.stopPropagation()
    reorderTab(workspaceId, sessionId, targetId)
  }

  if (tabIds.length === 0) return null

  const homeSelected =
    chatView !== 'session' || !activeSessionId || !tabIds.includes(activeSessionId)
  return (
    <div
      role="tablist"
      aria-label={t('workspaceTabs.label', { defaultValue: 'Open conversations' })}
      onKeyDown={handleTabKeys}
      className="flex h-9 min-w-0 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border/50 bg-background px-2 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <button
        type="button"
        role="tab"
        aria-selected={homeSelected}
        tabIndex={homeSelected ? 0 : -1}
        onClick={() => useUIStore.getState().navigateToHome()}
        className={`relative flex shrink-0 items-center gap-1.5 px-3 text-muted-foreground transition-colors hover:text-foreground ${homeSelected ? 'text-foreground' : ''}`}
      >
        <Home className="size-3.5" aria-hidden="true" />
        {t('workspaceTabs.home', { defaultValue: 'Home' })}
        {homeSelected && (
          <motion.span
            layoutId={`session-tab-underline-${scopeKey}`}
            className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
            transition={{ duration: 0.18 }}
          />
        )}
      </button>
      {tabIds.map((id) => {
        const session = scopedSessions.get(id)!
        const selected = chatView === 'session' && activeSessionId === id
        return (
          <div key={id} className="group relative flex min-w-0 shrink-0 items-center">
            <button
              type="button"
              role="tab"
              draggable
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => void openSessionOrFocusDetached(id)}
              onKeyDown={(event) => handleTabReorderKeys(event, id)}
              onDragStart={(event) => event.dataTransfer.setData('text/session-tab', id)}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('text/session-tab')) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                const draggedId = event.dataTransfer.getData('text/session-tab')
                if (draggedId) reorderTab(workspaceId, draggedId, id)
              }}
              title={session.title}
              className={`max-w-48 min-w-24 truncate py-2 pl-3 pr-7 text-left text-muted-foreground transition-colors hover:text-foreground ${selected ? 'text-foreground' : ''}`}
            >
              {session.title || t('workspaceTabs.untitled', { defaultValue: 'Untitled' })}
            </button>
            <button
              type="button"
              aria-label={t('workspaceTabs.close', {
                defaultValue: 'Close {{title}} tab',
                title: session.title || t('workspaceTabs.untitled', { defaultValue: 'Untitled' })
              })}
              onClick={() => closeSession(id)}
              className="absolute right-1.5 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
            {selected && (
              <motion.span
                layoutId={`session-tab-underline-${scopeKey}`}
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
                transition={{ duration: 0.18 }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
