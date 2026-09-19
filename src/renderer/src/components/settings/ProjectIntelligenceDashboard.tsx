import { BookOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chat-store'
import { CodeGraphDashboard } from './CodeGraphDashboard'
import { ProjectWikiPanel } from './ProjectWikiPanel'
import {
  SETTINGS_PANEL_CLASS,
  SettingsInfoNotice,
  SettingsPageHeader,
  SettingsPanelSection
} from './settings-primitives'

export function ProjectIntelligenceDashboard(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projectRoot = useChatStore(
    (state) => state.projects.find((project) => project.id === activeProjectId)?.workingFolder
  )

  return (
    <div className={SETTINGS_PANEL_CLASS}>
      <SettingsPageHeader
        icon={BookOpen}
        title={t('projectIntelligence.title')}
        description={t('projectIntelligence.description')}
      />
      <SettingsInfoNotice>
        {projectRoot
          ? t('projectIntelligence.activeProject', { path: projectRoot })
          : t('projectIntelligence.noProject')}
      </SettingsInfoNotice>
      <SettingsPanelSection title={t('projectIntelligence.wikiTitle')}>
        <ProjectWikiPanel projectRoot={projectRoot ?? null} embedded />
      </SettingsPanelSection>
      <SettingsPanelSection title={t('projectIntelligence.codeGraphTitle')}>
        <CodeGraphDashboard />
      </SettingsPanelSection>
    </div>
  )
}
