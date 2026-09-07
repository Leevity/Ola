import { BookOpen, Network } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chat-store'
import { CodeGraphDashboard } from './CodeGraphDashboard'
import { ProjectWikiPanel } from './ProjectWikiPanel'

export function ProjectIntelligenceDashboard(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projectRoot = useChatStore(
    (state) => state.projects.find((project) => project.id === activeProjectId)?.workingFolder
  )

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-muted/10 p-4">
        <div className="flex items-start gap-3">
          <BookOpen className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-medium">
              {t('plugin.projectIntelligence.title', { defaultValue: 'Project Intelligence' })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('plugin.projectIntelligence.description', {
                defaultValue:
                  'Use a lightweight project map for people and a deep code graph for structural analysis.'
              })}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {projectRoot
                ? t('plugin.projectIntelligence.activeProject', {
                    defaultValue: 'Active project: {{path}}',
                    path: projectRoot
                  })
                : t('plugin.projectIntelligence.noProject', {
                    defaultValue: 'Select a project with a working folder to use both capabilities.'
                  })}
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" />
          <h4 className="text-sm font-semibold">
            {t('plugin.projectIntelligence.wikiTitle', { defaultValue: 'Project Wiki' })}
          </h4>
        </div>
        <ProjectWikiPanel projectRoot={projectRoot ?? null} embedded />
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-primary" />
          <h4 className="text-sm font-semibold">
            {t('plugin.projectIntelligence.codeGraphTitle', { defaultValue: 'CodeGraph' })}
          </h4>
        </div>
        <CodeGraphDashboard />
      </section>
    </div>
  )
}
