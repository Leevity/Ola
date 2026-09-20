import * as React from 'react'
import { Code2, Laptop, Radio, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'

interface FirstSuccessPanelProps {
  hasLocalProject: boolean
  hasRemoteProject: boolean
  onUsePrompt: (prompt: string) => void
  onOpenTasks: () => void
}

export function FirstSuccessPanel({
  hasLocalProject,
  hasRemoteProject,
  onUsePrompt,
  onOpenTasks
}: FirstSuccessPanelProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const paths = [
    {
      id: 'local',
      icon: Code2,
      ready: hasLocalProject,
      title: t('firstSuccess.localTitle', { defaultValue: 'Local code' }),
      description: t('firstSuccess.localDescription', {
        defaultValue: 'Plan, change, verify, and report in the selected project.'
      }),
      action: () =>
        onUsePrompt(
          t('firstSuccess.localPrompt', {
            defaultValue:
              'Inspect this project, make a concise plan, implement the smallest safe change, run relevant checks, and report the files changed and verification results.'
          })
        )
    },
    {
      id: 'remote',
      icon: Server,
      ready: hasRemoteProject,
      title: t('firstSuccess.remoteTitle', { defaultValue: 'Remote diagnosis' }),
      description: t('firstSuccess.remoteDescription', {
        defaultValue:
          'Connect through SSH, diagnose with read-only checks, and return an audit trail.'
      }),
      action: () =>
        onUsePrompt(
          t('firstSuccess.remotePrompt', {
            defaultValue:
              'Run a read-only health diagnosis on the connected remote workspace. Explain each command, avoid mutations, and summarize the evidence and next safe action.'
          })
        )
    },
    {
      id: 'automation',
      icon: Radio,
      ready: true,
      title: t('firstSuccess.automationTitle', { defaultValue: 'Automation & delivery' }),
      description: t('firstSuccess.automationDescription', {
        defaultValue: 'Create a scheduled run, test delivery, and inspect the result in one place.'
      }),
      action: onOpenTasks
    }
  ]

  return (
    <section
      className="mt-5 rounded-xl border border-border/60 bg-muted/10 p-3"
      aria-label={t('firstSuccess.title', { defaultValue: 'First success paths' })}
    >
      <div className="mb-3 flex items-center gap-2">
        <Laptop className="size-4 text-muted-foreground" />
        <div>
          <h2 className="text-xs font-medium">
            {t('firstSuccess.title', { defaultValue: 'First success paths' })}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {t('firstSuccess.subtitle', {
              defaultValue:
                'Start with a guided workflow; you can customize it after the first successful run.'
            })}
          </p>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {paths.map((path) => {
          const Icon = path.icon
          return (
            <button
              key={path.id}
              type="button"
              disabled={!path.ready}
              onClick={path.action}
              className={cn(
                'rounded-lg border border-border/60 bg-background/45 p-3 text-left transition-colors',
                path.ready ? 'hover:bg-muted/60' : 'cursor-not-allowed opacity-55'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium">{path.title}</span>
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                {path.description}
              </p>
              <span className="mt-2 inline-block text-[10px] font-medium text-primary">
                {path.ready
                  ? t('firstSuccess.start', { defaultValue: 'Start path' })
                  : t('firstSuccess.selectRemote', { defaultValue: 'Select an SSH project first' })}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
