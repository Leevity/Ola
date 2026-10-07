import * as React from 'react'
import { BookOpen, LayoutDashboard, Network, Package } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CodeGraphDashboard } from '@renderer/components/settings/CodeGraphDashboard'
import { ProjectWikiPanel } from '@renderer/components/settings/ProjectWikiPanel'
import { ExecutionResultsPage } from '@renderer/components/tasks/ExecutionResultsPage'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { ChatHomePage } from './ChatHomePage'

/** Single entry point for global and project-scoped new tasks. */
export function WorkspaceHome(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const chatView = useUIStore((state) => state.chatView)
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projectRoot = useChatStore(
    (state) => state.projects.find((project) => project.id === activeProjectId)?.workingFolder
  )
  const [activeTab, setActiveTab] = React.useState<'overview' | 'wiki' | 'codegraph' | 'results'>(
    'overview'
  )

  React.useEffect(() => {
    setActiveTab('overview')
  }, [activeProjectId])

  if (chatView !== 'project') return <ChatHomePage />

  const tabs = [
    {
      id: 'overview' as const,
      label: t('workspaceHome.overview'),
      icon: LayoutDashboard
    },
    { id: 'wiki' as const, label: t('workspaceHome.wiki'), icon: BookOpen },
    { id: 'codegraph' as const, label: t('workspaceHome.codegraph'), icon: Network },
    { id: 'results' as const, label: t('workspaceHome.results'), icon: Package }
  ]

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <nav
        className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 py-2"
        aria-label={t('workspaceHome.projectNavigation')}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = tab.id === activeTab
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {tab.label}
            </button>
          )
        })}
      </nav>

      {activeTab === 'overview' ? (
        <ChatHomePage />
      ) : activeTab === 'results' && activeProjectId ? (
        <ExecutionResultsPage
          scopeProjectId={activeProjectId}
          onBack={() => setActiveTab('overview')}
        />
      ) : (
        <section
          className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
          aria-labelledby={`project-intelligence-${activeTab}`}
        >
          <div className="mx-auto w-full max-w-5xl">
            <div className="mb-4">
              <h2 id={`project-intelligence-${activeTab}`} className="text-lg font-semibold">
                {activeTab === 'wiki'
                  ? t('workspaceHome.wikiTitle')
                  : t('workspaceHome.codegraphTitle')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeTab === 'wiki'
                  ? t('workspaceHome.wikiDescription')
                  : t('workspaceHome.codegraphDescription')}
              </p>
            </div>
            {activeTab === 'wiki' ? (
              <ProjectWikiPanel projectRoot={projectRoot ?? null} embedded />
            ) : (
              <CodeGraphDashboard />
            )}
          </div>
        </section>
      )}
    </main>
  )
}
