import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Files, GitBranch, MessageSquare, Terminal } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { PreviewPanel } from '@renderer/components/layout/PreviewPanel'
import { ProjectTerminalDock } from '@renderer/components/terminal/ProjectTerminalDock'
import { SourceControlPanel } from '@renderer/components/scm/SourceControlPanel'
import {
  DEFAULT_PROJECT_WORKSPACE_LEFT_WIDTH,
  MIN_PROJECT_WORKSPACE_LEFT_WIDTH,
  getMaxProjectWorkspaceLeftWidth,
  getProjectTerminalDockLayout
} from '@renderer/lib/workbench/project-terminal-dock-layout'

type WorkspaceLeftView = 'explorer' | 'scm'

function ActivityButton({
  active,
  label,
  onClick,
  children
}: {
  active?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex size-10 items-center justify-center border-l-2 text-muted-foreground transition-colors hover:text-foreground',
        active ? 'border-l-primary text-foreground' : 'border-l-transparent'
      )}
    >
      {children}
    </button>
  )
}

export function WorkspaceView(): React.JSX.Element {
  const { t } = useTranslation(['layout', 'common'])
  const [leftView, setLeftView] = React.useState<WorkspaceLeftView>('explorer')
  const [leftWidth, setLeftWidth] = React.useState(DEFAULT_PROJECT_WORKSPACE_LEFT_WIDTH)
  const [workspaceWidth, setWorkspaceWidth] = React.useState(0)
  const [isDragging, setIsDragging] = React.useState(false)
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)
  const startXRef = React.useRef(0)
  const startWidthRef = React.useRef(DEFAULT_PROJECT_WORKSPACE_LEFT_WIDTH)

  const setMode = useUIStore((s) => s.setMode)
  const setBottomTerminalDockOpen = useUIStore((s) => s.setBottomTerminalDockOpen)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const sessionView = useChatStore(
    useShallow((state) => {
      const session = state.activeSessionId
        ? state.sessions.find((item) => item.id === state.activeSessionId)
        : undefined
      const project = session?.projectId
        ? state.projects.find((item) => item.id === session.projectId)
        : undefined
      return {
        sessionId: session?.id ?? null,
        projectId: session?.projectId ?? project?.id ?? null,
        projectName: project?.name,
        workingFolder: session?.workingFolder ?? project?.workingFolder ?? null,
        sshConnectionId: session?.sshConnectionId ?? project?.sshConnectionId ?? null
      }
    })
  )

  const terminalOpen = useUIStore((s) =>
    sessionView.projectId
      ? Boolean(s.bottomTerminalDockOpenByProjectId[sessionView.projectId])
      : false
  )
  const terminalDockArea = useUIStore((s) =>
    sessionView.projectId
      ? (s.terminalDockAreaByProjectId[sessionView.projectId] ?? 'bottom')
      : 'bottom'
  )
  const dockLayout = getProjectTerminalDockLayout({
    workspaceWidth,
    leftWidth,
    terminalOpen,
    preferredArea: terminalDockArea
  })

  React.useEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined) setWorkspaceWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!isDragging) return
    const onMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = event.clientX - startXRef.current
      const maxWidth = getMaxProjectWorkspaceLeftWidth(workspaceWidth, dockLayout.effectiveArea)
      setLeftWidth(
        Math.min(
          maxWidth,
          Math.max(MIN_PROJECT_WORKSPACE_LEFT_WIDTH, startWidthRef.current + delta)
        )
      )
    }
    const onUp = (): void => {
      draggingRef.current = false
      setIsDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dockLayout.effectiveArea, isDragging, workspaceWidth])

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    draggingRef.current = true
    startXRef.current = event.clientX
    startWidthRef.current = dockLayout.effectiveLeftWidth
    setIsDragging(true)
  }

  const goToChat = (): void => {
    setMode('execute')
    if (activeSessionId) updateSessionMode(activeSessionId, 'execute')
  }

  const toggleTerminal = (): void => {
    if (sessionView.projectId) setBottomTerminalDockOpen(sessionView.projectId, !terminalOpen)
  }

  return (
    <div ref={workspaceRef} className="flex flex-1 overflow-hidden bg-background">
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-border/50 py-1">
        <ActivityButton
          active={leftView === 'explorer'}
          label={t('layout:files', { defaultValue: 'Explorer' })}
          onClick={() => setLeftView('explorer')}
        >
          <Files className="size-5" />
        </ActivityButton>
        <ActivityButton
          active={leftView === 'scm'}
          label={t('layout:scmTitle', { defaultValue: 'Source Control' })}
          onClick={() => setLeftView('scm')}
        >
          <GitBranch className="size-5" />
        </ActivityButton>
        <div className="flex-1" />
        <ActivityButton
          active={terminalOpen}
          label={t('layout:commandPalette.toggleTerminal', { defaultValue: 'Terminal' })}
          onClick={toggleTerminal}
        >
          <Terminal className="size-5" />
        </ActivityButton>
        <ActivityButton
          label={t('common:mode.cowork', { defaultValue: 'Chat' })}
          onClick={goToChat}
        >
          <MessageSquare className="size-5" />
        </ActivityButton>
      </div>

      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-border/50"
        style={{ width: dockLayout.effectiveLeftWidth }}
      >
        {leftView === 'explorer' ? (
          sessionView.workingFolder ? (
            <FileTreePanel
              sessionId={sessionView.sessionId}
              surface="agent"
              watchEnabled={leftView === 'explorer'}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('layout:scmNoFolder', { defaultValue: 'Open a working folder to browse files.' })}
            </div>
          )
        ) : (
          <SourceControlPanel sessionId={sessionView.sessionId} />
        )}
      </div>

      <div
        className={cn(
          'w-1 shrink-0 cursor-col-resize transition-colors hover:bg-primary/30',
          isDragging && 'bg-primary/30'
        )}
        onMouseDown={startResize}
      />

      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 overflow-hidden',
          dockLayout.effectiveArea === 'right' ? 'flex-row' : 'flex-col'
        )}
      >
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-hidden',
            dockLayout.effectiveArea === 'right' && 'min-w-[220px]'
          )}
        >
          <PreviewPanel embedded showTabStrip />
          {terminalOpen && dockLayout.effectiveArea === 'bottom' && sessionView.projectId ? (
            <div className="min-h-0 shrink-0 border-t border-border/50">
              <ProjectTerminalDock
                projectId={sessionView.projectId}
                projectName={sessionView.projectName}
                workingFolder={sessionView.workingFolder ?? null}
                sshConnectionId={sessionView.sshConnectionId}
                dockArea="bottom"
                canMove
                moveDisabledReason={
                  !dockLayout.canMoveRight
                    ? t('layout:terminalDock.rightDockNeedsSpace', {
                        defaultValue: 'Expand the workspace to move the terminal to the right.'
                      })
                    : undefined
                }
              />
            </div>
          ) : null}
        </div>
        {terminalOpen && dockLayout.effectiveArea === 'right' && sessionView.projectId ? (
          <div className="min-h-0 w-[38%] min-w-[180px] max-w-[520px] shrink-0 border-l border-border/50">
            <ProjectTerminalDock
              projectId={sessionView.projectId}
              projectName={sessionView.projectName}
              workingFolder={sessionView.workingFolder ?? null}
              sshConnectionId={sessionView.sshConnectionId}
              dockArea="right"
              canMove
            />
          </div>
        ) : null}
      </div>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
