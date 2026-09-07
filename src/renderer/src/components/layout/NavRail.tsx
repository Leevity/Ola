import { CalendarDays, FolderOpen, Pencil, Search, Settings, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import packageJson from '../../../../../package.json'

type PrimaryNavigationAction = 'new-task' | 'search' | 'projects' | 'tasks' | 'capabilities'

const capabilityTabs = new Set([
  'plugin',
  'extension',
  'mcp',
  'websearch',
  'skillsmarket',
  'channel',
  'wiki'
])

export function NavRail(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSurface = useUIStore((state) => state.activeSurface)
  const chatView = useUIStore((state) => state.chatView)
  const settingsTab = useUIStore((state) => state.settingsTab)
  const activeProjectId = useChatStore((state) => state.activeProjectId)

  const navItems: Array<{
    value: PrimaryNavigationAction
    icon: React.ReactNode
    label: string
    active: boolean
  }> = [
    {
      value: 'new-task',
      icon: <Pencil className="size-5" aria-hidden="true" />,
      label: t('navRail.newTask', { defaultValue: 'New task' }),
      active: activeSurface === 'workspace' && chatView === 'home'
    },
    {
      value: 'search',
      icon: <Search className="size-5" aria-hidden="true" />,
      label: t('navRail.search', { defaultValue: 'Search' }),
      active: false
    },
    {
      value: 'projects',
      icon: <FolderOpen className="size-5" aria-hidden="true" />,
      label: t('navRail.projects', { defaultValue: 'Projects' }),
      active:
        activeSurface === 'workspace' &&
        (chatView === 'project' ||
          chatView === 'archive' ||
          chatView === 'channels' ||
          chatView === 'git')
    },
    {
      value: 'tasks',
      icon: <CalendarDays className="size-5" aria-hidden="true" />,
      label: t('navRail.tasks'),
      active: activeSurface === 'tasks'
    },
    {
      value: 'capabilities',
      icon: <Wand2 className="size-5" aria-hidden="true" />,
      label: t('navRail.capabilities', { defaultValue: 'Capabilities' }),
      active: activeSurface === 'settings' && capabilityTabs.has(settingsTab)
    }
  ]

  const handleNavClick = (item: PrimaryNavigationAction): void => {
    const ui = useUIStore.getState()
    if (item === 'new-task') {
      ui.navigateToHome()
      ui.setLeftSidebarOpen(true)
      return
    }
    if (item === 'search') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      return
    }
    if (item === 'projects') {
      if (activeProjectId) ui.navigateToProject(activeProjectId)
      else ui.navigateToHome()
      ui.setLeftSidebarOpen(true)
      return
    }
    if (item === 'tasks') {
      ui.openTasksPage()
      return
    }
    ui.openSettingsPage('plugin')
  }

  return (
    <nav
      className="flex h-full w-12 shrink-0 flex-col items-center border-r bg-muted/30 py-2"
      aria-label={t('navRail.primaryNavigation', { defaultValue: 'Primary navigation' })}
    >
      <div className="flex flex-col items-center gap-1">
        {navItems.map((item) => (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => handleNavClick(item.value)}
                aria-label={item.label}
                aria-current={item.active ? 'page' : undefined}
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.active
                    ? 'bg-primary/10 text-primary shadow-sm'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {item.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => useUIStore.getState().openSettingsPage()}
              aria-label={t('navRail.settings')}
              aria-current={activeSurface === 'settings' ? 'page' : undefined}
              className={cn(
                'flex size-9 items-center justify-center rounded-lg transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                activeSurface === 'settings'
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Settings className="size-5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('navRail.settings')}</TooltipContent>
        </Tooltip>
        <span className="select-none text-[9px] text-muted-foreground/40">
          v{packageJson.version}
        </span>
      </div>
    </nav>
  )
}
