import { useTranslation } from 'react-i18next'

export function SshTerminalThemePanel(): React.JSX.Element {
  const { t } = useTranslation('ssh')

  return (
    <div className="rounded-[18px] border border-dashed border-border bg-muted/40 px-4 py-3 text-[0.78rem] leading-6 text-muted-foreground">
      {t('workspace.terminalTheme.globalHint')}
    </div>
  )
}
