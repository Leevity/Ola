import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { useUIStore } from '@renderer/stores/ui-store'
import { useTranslation } from 'react-i18next'
import { Separator } from '@renderer/components/ui/separator'
import { getWorkbenchActionsSnapshot, subscribeWorkbenchRegistry } from '@renderer/lib/workbench'
import { useMemo, useSyncExternalStore } from 'react'

const shortcutGroups = [
  {
    labelKey: 'general',
    items: [{ keys: 'Ctrl+Shift+N', descKey: 'newConversation' }]
  },
  {
    labelKey: 'chatGroup',
    items: [
      { keys: 'Enter', descKey: 'sendMessage' },
      { keys: 'Ctrl+Enter', descKey: 'sendMessageAlt' },
      { keys: 'Shift+Enter', descKey: 'newLine' },
      { keys: '↑/↓', descKey: 'inputHistory' }
    ]
  },
  {
    labelKey: 'toolPermissions',
    items: [
      { keys: 'Y', descKey: 'allowTool' },
      { keys: 'N / Esc', descKey: 'denyTool' }
    ]
  }
]

export function KeyboardShortcutsDialog(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const workbenchActions = useSyncExternalStore(
    subscribeWorkbenchRegistry,
    getWorkbenchActionsSnapshot,
    getWorkbenchActionsSnapshot
  )
  const workbenchShortcutGroups = useMemo(() => {
    const groups = new Map<string, typeof workbenchActions>()
    for (const action of workbenchActions) {
      if (!action.shortcut) continue
      const group = action.group || t('shortcuts.navigation')
      groups.set(group, [...(groups.get(group) ?? []), action])
    }
    return [...groups.entries()]
  }, [t, workbenchActions])
  const open = useUIStore((s) => s.shortcutsOpen)
  const setOpen = useUIStore((s) => s.setShortcutsOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="settings-dialog max-w-sm sm:max-w-md max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-3 overflow-y-auto py-2 pr-2">
          {shortcutGroups.map((group, gi) => (
            <div key={group.labelKey}>
              {gi > 0 && <Separator className="mb-3" />}
              <p className="mb-1 px-2 text-xs font-medium text-muted-foreground/60 uppercase tracking-wider">
                {t(`shortcuts.${group.labelKey}`)}
              </p>
              <div className="space-y-0.5">
                {group.items.map((s) => (
                  <div
                    key={s.keys}
                    className="flex items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-muted/50"
                  >
                    <span className="text-muted-foreground">{t(`shortcuts.${s.descKey}`)}</span>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {workbenchShortcutGroups.map(([group, actions]) => (
            <div key={group}>
              <Separator className="mb-3" />
              <p className="mb-1 px-2 text-xs font-medium text-muted-foreground/60 uppercase tracking-wider">
                {group}
              </p>
              <div className="space-y-0.5">
                {actions.map((action) => (
                  <div
                    key={action.id}
                    className="flex items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-muted/50"
                  >
                    <span className="text-muted-foreground">{action.title}</span>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                      {action.shortcut}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
