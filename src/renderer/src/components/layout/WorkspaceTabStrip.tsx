import { useCallback, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { switchWorkspace } from '@renderer/lib/switch-workspace'
import { LOCAL_PERSONAL_WORKSPACE } from '@renderer/lib/workspace-context'
import { focusAdjacentWorkspaceTab } from '@renderer/lib/workbench/workspace-tab-navigation'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

export function WorkspaceTabStrip(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const remoteWorkspaces = useWorkspaceStore((state) => state.olaWorkspaces)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const workspaces = [LOCAL_PERSONAL_WORKSPACE, ...remoteWorkspaces]

  const selectWorkspace = useCallback(
    (workspaceId: string): void => {
      if (workspaceId === activeWorkspaceId) return
      void switchWorkspace(workspaceId).then((switched) => {
        if (!switched) toast.error(t('workspaceTabs.busy', { defaultValue: 'Workspace is busy' }))
      })
    },
    [activeWorkspaceId, t]
  )

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    focusAdjacentWorkspaceTab(event.key, document.activeElement as HTMLButtonElement, tabs, () =>
      event.preventDefault()
    )
  }

  if (workspaces.length < 2) return null

  return (
    <div
      role="tablist"
      aria-label={t('workspaceTabs.workspaces', { defaultValue: 'Workspaces' })}
      onKeyDown={handleKeys}
      className="flex h-8 min-w-0 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border/40 bg-muted/15 px-3 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {workspaces.map((workspace) => {
        const selected = workspace.id === activeWorkspaceId
        const label =
          workspace.kind === 'local-personal'
            ? t('workspaceTabs.personal', { defaultValue: 'Personal' })
            : workspace.name
        return (
          <button
            key={workspace.id}
            type="button"
            role="tab"
            data-workspace-id={workspace.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => selectWorkspace(workspace.id)}
            title={workspace.name}
            className={`relative max-w-48 shrink-0 truncate px-3 text-muted-foreground transition-colors hover:text-foreground ${selected ? 'font-medium text-foreground' : ''}`}
          >
            {label}
            {selected && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
            )}
          </button>
        )
      })}
    </div>
  )
}
