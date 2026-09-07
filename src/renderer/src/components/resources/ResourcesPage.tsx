import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Brain,
  Command,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  useResourcesStore,
  type ManagedResourceItem,
  type ResourceKind
} from '@renderer/stores/resources-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { profileMatches } from '@renderer/lib/agent/sub-agents/profile'
import type { TaskProfile } from '@renderer/lib/task-profile'

type ResourceKindOption = {
  value: ResourceKind
  icon: React.ReactNode
}

type ProfileFilter = 'recommended' | 'work' | 'code' | 'all'
type ResourceTranslator = (key: string, options?: Record<string, unknown>) => string

const workspaceTemplates = [
  { id: 'AGENTS.md', scope: 'project' },
  { id: 'SOUL.md', scope: 'global-project' },
  { id: 'USER.md', scope: 'global-project' },
  { id: 'MEMORY.md', scope: 'global-project' }
] as const

const resourceKindOptions: ResourceKindOption[] = [
  { value: 'agents', icon: <Brain className="size-4" /> },
  { value: 'commands', icon: <Command className="size-4" /> }
]

function SourceBadge({
  source,
  t
}: {
  source: ManagedResourceItem['source']
  t: (key: string, options?: Record<string, unknown>) => string
}): React.JSX.Element {
  return (
    <Badge variant={source === 'bundled' ? 'outline' : 'secondary'}>
      {source === 'bundled'
        ? t('resourcesPage.source.bundled', { defaultValue: 'Built-in' })
        : source === 'overridden'
          ? t('resourcesPage.source.overridden', { defaultValue: 'Overridden' })
          : t('resourcesPage.source.user', { defaultValue: 'Custom' })}
    </Badge>
  )
}

function ProfileBadge({
  item,
  t
}: {
  item: ManagedResourceItem
  t: (key: string, options?: Record<string, unknown>) => string
}): React.JSX.Element {
  const label = item.profileMeta.profiles.includes('both')
    ? t('resourcesPage.profile.both', { defaultValue: 'Work + Code' })
    : item.profileMeta.profiles.includes('code')
      ? t('resourcesPage.profile.code', { defaultValue: 'Code' })
      : t('resourcesPage.profile.work', { defaultValue: 'Work' })
  return <Badge variant="outline">{label}</Badge>
}

function TemplatePanel({ t }: { t: ResourceTranslator }): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h2 className="text-base font-semibold">
          {t('resourcesPage.templates.title', { defaultValue: 'Workspace templates' })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('resourcesPage.templates.subtitle', {
            defaultValue:
              'These files define the Agent working boundaries, personality, user preferences, and long-term context.'
          })}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {workspaceTemplates.map((template) => (
            <div key={template.id} className="rounded-xl border bg-background p-4">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="size-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{template.id}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`resourcesPage.templates.items.${template.id}.description`, {
                      defaultValue: 'A long-lived workspace configuration file.'
                    })}
                  </p>
                  <Badge className="mt-3" variant="outline">
                    {t(`resourcesPage.templates.scope.${template.scope}`, {
                      defaultValue: template.scope === 'project' ? 'Project' : 'Global / project'
                    })}
                  </Badge>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">
            {t('resourcesPage.templates.mappingTitle', { defaultValue: 'Capability boundaries' })}
          </strong>
          <p className="mt-1">
            {t('resourcesPage.templates.mapping', {
              defaultValue:
                'An Agent is an execution role, a Command is a shortcut workflow, a Skill is a specialized capability, and a template is long-lived workspace configuration.'
            })}
          </p>
        </div>
      </div>
    </div>
  )
}

function getResourceName(t: ResourceTranslator, item: ManagedResourceItem): string {
  return t(`resourcesPage.items.${item.kind}.${item.name}.name`, { defaultValue: item.name })
}

function getResourceDescription(t: ResourceTranslator, item: ManagedResourceItem): string {
  return t(`resourcesPage.items.${item.kind}.${item.name}.description`, {
    defaultValue:
      item.description || t('resourcesPage.noDescription', { defaultValue: 'No summary available' })
  })
}

export function ResourcesPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeKind = useResourcesStore((s) => s.activeKind)
  const searchQuery = useResourcesStore((s) => s.searchQuery)
  const agents = useResourcesStore((s) => s.agents)
  const commands = useResourcesStore((s) => s.commands)
  const selectedIds = useResourcesStore((s) => s.selectedIds)
  const selectedResource = useResourcesStore((s) => s.selectedResource)
  const editing = useResourcesStore((s) => s.editing)
  const draftContent = useResourcesStore((s) => s.draftContent)
  const listLoading = useResourcesStore((s) => s.listLoading)
  const detailLoading = useResourcesStore((s) => s.detailLoading)
  const saving = useResourcesStore((s) => s.saving)
  const error = useResourcesStore((s) => s.error)
  const loadAll = useResourcesStore((s) => s.loadAll)
  const setActiveKind = useResourcesStore((s) => s.setActiveKind)
  const setSearchQuery = useResourcesStore((s) => s.setSearchQuery)
  const selectResource = useResourcesStore((s) => s.selectResource)
  const setEditing = useResourcesStore((s) => s.setEditing)
  const setDraftContent = useResourcesStore((s) => s.setDraftContent)
  const createCommand = useResourcesStore((s) => s.createCommand)
  const saveSelected = useResourcesStore((s) => s.saveSelected)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newCommandName, setNewCommandName] = useState('')
  const defaultTaskProfile = useSettingsStore((state) => state.defaultTaskProfile)
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('recommended')
  const [showTemplates, setShowTemplates] = useState(false)

  const currentItems = activeKind === 'agents' ? agents : commands
  const currentSelectedId = selectedIds[activeKind]

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const profileItems = currentItems.filter((item) => {
      if (profileFilter === 'all') return true
      if (profileFilter === 'recommended') {
        return (
          item.profileMeta.recommended &&
          profileMatches(item.profileMeta, defaultTaskProfile as TaskProfile)
        )
      }
      return profileMatches(item.profileMeta, profileFilter)
    })
    if (!query) return profileItems

    return profileItems.filter((item) => {
      const haystack =
        `${getResourceName(t, item)}\n${getResourceDescription(t, item)}\n${item.name}\n${item.description}\n${item.path}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [currentItems, defaultTaskProfile, profileFilter, searchQuery, t])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (showTemplates) return
    if (currentItems.length === 0) {
      void selectResource(null, activeKind)
      return
    }

    if (!currentSelectedId) {
      void selectResource(currentItems[0].id, activeKind)
      return
    }

    if (
      !selectedResource ||
      selectedResource.kind !== activeKind ||
      selectedResource.id !== currentSelectedId
    ) {
      void selectResource(currentSelectedId, activeKind)
    }
  }, [activeKind, currentItems, currentSelectedId, selectedResource, selectResource, showTemplates])

  const handleSave = async (): Promise<void> => {
    const result = await saveSelected()
    toast[result.success ? 'success' : 'error'](
      result.success
        ? t('resourcesPage.saved', { defaultValue: 'Saved' })
        : result.error || t('resourcesPage.saveFailed', { defaultValue: 'Save failed' })
    )
  }

  const handleCreateCommand = async (): Promise<void> => {
    const result = await createCommand(newCommandName)
    toast[result.success ? 'success' : 'error'](
      result.success
        ? t('resourcesPage.commandCreated', { defaultValue: 'Command created' })
        : result.error ||
            t('resourcesPage.commandCreateFailed', { defaultValue: 'Failed to create command' })
    )

    if (!result.success) return

    setCreateDialogOpen(false)
    setNewCommandName('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2.5 shrink-0">
        <button
          onClick={() => useUIStore.getState().closeResourcesPage()}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div>
          <h1 className="text-sm font-semibold">
            {t('resourcesPage.title', { defaultValue: 'Agents and Commands' })}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t('resourcesPage.subtitle', {
              defaultValue:
                'Manage Agents, Commands, and workspace templates by Work / Code profile'
            })}
          </p>
        </div>
        <div className="flex-1" />
        {activeKind === 'commands' ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="size-3.5" />
            {t('resourcesPage.addCommand', { defaultValue: 'Add command' })}
          </Button>
        ) : null}
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('resourcesPage.searchPlaceholder', {
              defaultValue: 'Search name, summary or path'
            })}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 border-b px-4 py-2 shrink-0" role="tablist">
        {(['recommended', 'work', 'code', 'all'] as ProfileFilter[]).map((filter) => (
          <button
            key={filter}
            type="button"
            role="tab"
            aria-selected={profileFilter === filter}
            onClick={() => setProfileFilter(filter)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              profileFilter === filter
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {filter === 'recommended'
              ? t('resourcesPage.recommended', { defaultValue: 'Recommended' })
              : filter === 'work'
                ? t('resourcesPage.work', { defaultValue: 'Work' })
                : filter === 'code'
                  ? t('resourcesPage.code', { defaultValue: 'Code' })
                  : t('resourcesPage.all', { defaultValue: 'All' })}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {t('resourcesPage.currentProfile', {
            profile: defaultTaskProfile === 'code' ? 'Code 编程' : 'Work 工作',
            defaultValue: `Current profile: ${defaultTaskProfile === 'code' ? 'Code' : 'Work'}`
          })}
        </span>
      </div>

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open)
          if (!open) setNewCommandName('')
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('resourcesPage.addCommand', { defaultValue: 'Add command' })}
            </DialogTitle>
            <DialogDescription>
              {t('resourcesPage.addCommandDesc', {
                defaultValue:
                  'Please enter a kebab-case command name. After creation, it will be written to the user command directory and enter edit mode.'
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground/80">
              {t('resourcesPage.commandName', { defaultValue: 'Command name' })}
            </label>
            <Input
              value={newCommandName}
              onChange={(event) => setNewCommandName(event.target.value)}
              placeholder={t('resourcesPage.commandNamePlaceholder', {
                defaultValue: 'e.g. project-review'
              })}
              className="text-sm"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !saving) {
                  event.preventDefault()
                  void handleCreateCommand()
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('resourcesPage.commandNameHint', {
                defaultValue:
                  'Only lowercase letters, numbers and hyphens allowed, e.g. release-note.'
              })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t('resourcesPage.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={() => void handleCreateCommand()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('resourcesPage.create', { defaultValue: 'Create' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-36 shrink-0 flex-col border-r bg-muted/10 p-2 gap-1">
          {resourceKindOptions.map((option) => {
            const count = option.value === 'agents' ? agents.length : commands.length
            return (
              <button
                key={option.value}
                onClick={() => {
                  setShowTemplates(false)
                  setActiveKind(option.value)
                }}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
                  activeKind === option.value
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {option.icon}
                  {t(`resourcesPage.kind.${option.value}`, {
                    defaultValue: option.value === 'agents' ? 'SubAgents' : 'Commands'
                  })}
                </span>
                <span className="text-[11px] opacity-70">
                  {t('resourcesPage.count', { count, defaultValue: `${count} items` })}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => setShowTemplates(true)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
              showTemplates
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4" />
              {t('resourcesPage.kind.templates', { defaultValue: 'Templates' })}
            </span>
            <span className="text-[11px] opacity-70">{workspaceTemplates.length}</span>
          </button>
        </div>

        {showTemplates ? (
          <TemplatePanel t={t} />
        ) : (
          <>
            <div className="flex w-80 shrink-0 flex-col border-r bg-muted/20 overflow-hidden">
              <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                {t('resourcesPage.listTitle', { defaultValue: 'Resource list' })}
              </div>
              <div className="flex-1 overflow-y-auto px-2 py-2">
                {listLoading ? (
                  <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                    <Loader2 className="mr-2 size-3.5 animate-spin" />
                    {t('resourcesPage.loadingList', { defaultValue: 'Loading list...' })}
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                    <p className="text-sm text-muted-foreground">
                      {t('resourcesPage.empty', { defaultValue: 'No available resources' })}
                    </p>
                    <p className="text-xs text-muted-foreground/70">
                      {t('resourcesPage.emptyDesc', {
                        defaultValue: 'Try switching type or modifying search term'
                      })}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {filteredItems.map((item) => {
                      const selected = currentSelectedId === item.id
                      return (
                        <button
                          key={item.id}
                          onClick={() => void selectResource(item.id, activeKind)}
                          className={cn(
                            'rounded-lg border px-3 py-2 text-left transition-colors',
                            selected
                              ? 'border-primary/30 bg-primary/10'
                              : 'border-transparent bg-background/70 hover:bg-muted'
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">
                                {getResourceName(t, item)}
                              </div>
                              <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                                {getResourceDescription(t, item)}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <ProfileBadge item={item} t={t} />
                              <SourceBadge source={item.source} t={t} />
                              {item.kind === 'commands' && item.effective ? (
                                <Badge variant="outline">
                                  {t('resourcesPage.effective', { defaultValue: 'Active' })}
                                </Badge>
                              ) : null}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {selectedResource ? (
                <>
                  <div className="flex items-start gap-3 border-b px-4 py-3 shrink-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-sm font-semibold">
                          {getResourceName(t, selectedResource)}
                        </h2>
                        <ProfileBadge item={selectedResource} t={t} />
                        <SourceBadge source={selectedResource.source} t={t} />
                        {selectedResource.kind === 'commands' && selectedResource.effective ? (
                          <Badge variant="outline">
                            {t('resourcesPage.effective', { defaultValue: 'Active' })}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {getResourceDescription(t, selectedResource)}
                      </p>
                      <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground/80">
                        {selectedResource.path}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {editing ? (
                        <>
                          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(false)}>
                            <Eye className="size-3.5" />
                          </Button>
                          <Button
                            size="icon-sm"
                            onClick={() => void handleSave()}
                            disabled={saving}
                          >
                            {saving ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Save className="size-3.5" />
                            )}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditing(true)}
                          disabled={!selectedResource.editable}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {!selectedResource.editable ? (
                    <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
                      {t('resourcesPage.readonlyNotice', {
                        defaultValue:
                          'This is a built-in resource, current version only supports preview, not direct editing.'
                      })}
                    </div>
                  ) : null}

                  {error ? (
                    <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
                      {error}
                    </div>
                  ) : null}

                  <div className="flex-1 overflow-y-auto">
                    {detailLoading ? (
                      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        {t('resourcesPage.loadingDetail', { defaultValue: 'Loading content...' })}
                      </div>
                    ) : editing ? (
                      <textarea
                        value={draftContent ?? ''}
                        onChange={(event) => setDraftContent(event.target.value)}
                        className="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed focus:outline-none"
                        spellCheck={false}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90">
                        {selectedResource.content}
                      </pre>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('resourcesPage.selectTitle', { defaultValue: 'Select a resource' })}
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    {t('resourcesPage.selectDesc', {
                      defaultValue:
                        'Switch resource type on the left and select specific entries in the list.'
                    })}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
