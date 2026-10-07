import { useCallback, useSyncExternalStore } from 'react'
import {
  MessageSquare,
  CircleHelp,
  Code2,
  ShieldCheck,
  Pin,
  Cpu,
  Sparkles,
  BriefcaseBusiness
} from 'lucide-react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator
} from '@renderer/components/ui/command'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { useMemo } from 'react'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { isProviderAvailableForModelSelection } from '@renderer/stores/provider-store'
import { useWorkspaceModelRoute, useWorkspaceProviders } from '@renderer/hooks/use-workspace-models'
import { openSessionOrFocusDetached } from '@renderer/lib/session-window'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { getWorkbenchActionsSnapshot, subscribeWorkbenchRegistry } from '@renderer/lib/workbench'

export function CommandPalette(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const open = useUIStore((s) => s.commandPaletteOpen)
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen)
  const providers = useWorkspaceProviders()
  const mainModelRoute = useWorkspaceModelRoute('main')
  const availableModels = useMemo(
    () =>
      providers
        .filter(isProviderAvailableForModelSelection)
        .flatMap((provider) =>
          provider.models
            .filter(
              (model) => model.id && model.enabled && (!model.category || model.category === 'chat')
            )
            .map((model) => ({ provider, model }))
        ),
    [providers]
  )
  const workbenchActions = useSyncExternalStore(
    subscribeWorkbenchRegistry,
    getWorkbenchActionsSnapshot,
    getWorkbenchActionsSnapshot
  )
  const workbenchActionGroups = useMemo(() => {
    const groups = new Map<string, typeof workbenchActions>()
    for (const action of workbenchActions) {
      if (action.showInPalette === false) continue
      const group = action.group || t('commandPalette.actions')
      groups.set(group, [...(groups.get(group) ?? []), action])
    }
    return [...groups.entries()]
  }, [t, workbenchActions])

  const allSessions = useChatStore((s) => s.sessions)
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const sessions = useMemo(
    () => allSessions.filter((s) => (s.workspaceId ?? 'local-personal') === workspaceId),
    [allSessions, workspaceId]
  )
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const updateSessionTaskProfile = useChatStore((s) => s.updateSessionTaskProfile)
  const runAndClose = useCallback(
    (fn: () => void) => {
      fn()
      setOpen(false)
    },
    [setOpen]
  )

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const otherSessions = [...sessions]
    .filter((s) => s.id !== activeSessionId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })

  // Extract searchable text snippets from session messages
  const sessionKeywords = (s: (typeof sessions)[0]): string => {
    if (!s.messagesLoaded) return ''
    const texts: string[] = []
    for (const m of s.messages) {
      if (typeof m.content === 'string') {
        texts.push(m.content.slice(0, 200))
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') texts.push(b.text.slice(0, 200))
        }
      }
      if (texts.length >= 5) break
    }
    return texts.join(' ').slice(0, 500)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      showCloseButton={false}
      title={t('commandPalette.title')}
      description={t('commandPalette.description')}
    >
      <CommandInput placeholder={t('commandPalette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>

        {/* Quick Actions */}
        {workbenchActionGroups.map(([group, actions]) => (
          <CommandGroup key={group} heading={group}>
            {actions.map((action) => (
              <CommandItem
                key={action.id}
                keywords={action.keywords}
                disabled={action.enabledWhen ? !action.enabledWhen() : false}
                onSelect={() => runAndClose(() => void action.run())}
              >
                <Sparkles className="size-4" />
                <span>{action.title}</span>
                {action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />

        {/* Switch Model */}
        <CommandGroup heading={t('commandPalette.switchModel')}>
          {availableModels.length === 0 ? (
            <CommandItem disabled>{t('commandPalette.noAvailableModels')}</CommandItem>
          ) : (
            availableModels.map(({ provider, model }) => (
              <CommandItem
                key={`${provider.id}:${model.id}`}
                value={`${provider.name} ${model.name} ${model.id}`}
                disabled={
                  activeSession
                    ? activeSession.modelSelectionMode === 'manual' &&
                      provider.id === activeSession.providerId &&
                      model.id === activeSession.modelId
                    : provider.id === mainModelRoute.providerId &&
                      model.id === mainModelRoute.modelId &&
                      useSettingsStore.getState().mainModelSelectionMode === 'manual'
                }
                onSelect={() =>
                  runAndClose(() => {
                    if (activeSession) {
                      useChatStore
                        .getState()
                        .setSessionModelManual(activeSession.id, provider.id, model.id)
                      if (activeSession.pluginId) {
                        void useChannelStore.getState().updateChannel(activeSession.pluginId, {
                          providerId: provider.id,
                          model: model.id
                        })
                      }
                    } else {
                      if (provider.id !== mainModelRoute.providerId) {
                        mainModelRoute.setProvider(provider.id)
                      }
                      mainModelRoute.setModel(model.id)
                      useSettingsStore
                        .getState()
                        .updateSettings({ mainModelSelectionMode: 'manual' })
                    }
                    toast.success(t('commandPalette.modelSelected', { model: model.name }))
                  })
                }
              >
                <Cpu className="size-4" />
                <span>{model.name}</span>
                <CommandShortcut>{provider.name}</CommandShortcut>
              </CommandItem>
            ))
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandSeparator />

        <CommandGroup heading={t('commandPalette.switchProfile')}>
          {(['work', 'code'] as const)
            .filter((profile) => profile !== activeSession?.taskProfile)
            .map((profile) => (
              <CommandItem
                key={profile}
                disabled={Boolean(activeSession?.taskProfileLocked || activeSession?.messageCount)}
                onSelect={() =>
                  runAndClose(() => {
                    if (!activeSessionId) return
                    updateSessionTaskProfile(activeSessionId, profile)
                  })
                }
              >
                {profile === 'work' ? (
                  <BriefcaseBusiness className="size-4" />
                ) : (
                  <Code2 className="size-4" />
                )}
                <span>{t(`sidebar.taskProfile.${profile}.title`)}</span>
              </CommandItem>
            ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Quick Prompts */}
        <CommandGroup heading={t('commandPalette.quickPrompts')}>
          {[
            {
              label: t('commandPalette.explainCode'),
              prompt: t('commandPalette.quickPromptText.explainCode')
            },
            {
              label: t('commandPalette.findBugs'),
              prompt: t('commandPalette.quickPromptText.findBugs')
            },
            {
              label: t('commandPalette.addErrorHandling'),
              prompt: t('commandPalette.quickPromptText.addErrorHandling')
            },
            {
              label: t('commandPalette.writeTests'),
              prompt: t('commandPalette.quickPromptText.writeTests')
            },
            {
              label: t('commandPalette.refactor'),
              prompt: t('commandPalette.quickPromptText.refactor')
            },
            {
              label: t('commandPalette.addTypes'),
              prompt: t('commandPalette.quickPromptText.addTypes')
            }
          ].map((p) => (
            <CommandItem
              key={p.label}
              onSelect={() =>
                runAndClose(() => {
                  useUIStore.getState().setPendingInsertText(p.prompt)
                })
              }
            >
              <Sparkles className="size-4" />
              <span>{p.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* All Sessions (searchable by title + message content) */}
        {otherSessions.length > 0 && (
          <CommandGroup heading={t('commandPalette.sessionsGroup')}>
            {otherSessions.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.title} ${sessionKeywords(s)}`}
                onSelect={() =>
                  runAndClose(() => {
                    void openSessionOrFocusDetached(s.id)
                  })
                }
              >
                {s.mode === 'chat' ? (
                  <MessageSquare className="size-4" />
                ) : s.mode === 'clarify' ? (
                  <CircleHelp className="size-4" />
                ) : s.mode === 'acp' ? (
                  <ShieldCheck className="size-4" />
                ) : (
                  <Code2 className="size-4" />
                )}
                <span className="truncate">{s.title}</span>
                <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/40">
                  {s.pinned && <Pin className="size-2.5" />}
                  {t('commandPalette.messageCount', { count: s.messageCount })}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
