import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cable,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Globe2,
  Laptop,
  Loader2,
  Monitor,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  Trash2,
  Wifi,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import type {
  RemoteConnection,
  RemoteConnectionKind,
  RemoteSession
} from '@renderer/lib/remote/remote-types'
import { useRemoteStore } from '@renderer/stores/remote-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { SshPage } from '@renderer/components/ssh/SshPage'
import { IronRdpViewer } from './IronRdpViewer'
import { NoVncViewer } from './NoVncViewer'

type DirectKind = Extract<RemoteConnectionKind, 'rdp' | 'vnc'>
type WorkspaceKind = 'ssh' | 'direct' | 'managed' | 'mobile'
type WorkspaceTab = { id: string; kind: WorkspaceKind; title: string }

type EditorState = {
  id: string | null
  kind: DirectKind
  name: string
  host: string
  port: string
  username: string
  domain: string
  password: string
}

const emptyEditor = (kind: DirectKind = 'rdp'): EditorState => ({
  id: null,
  kind,
  name: '',
  host: '',
  port: kind === 'rdp' ? '3389' : '5900',
  username: '',
  domain: '',
  password: ''
})

function connectionIcon(kind: RemoteConnectionKind): React.JSX.Element {
  return kind === 'rdp' ? <Monitor className="size-4" /> : <Laptop className="size-4" />
}

function formatLastConnected(value: number | null, neverLabel: string): string {
  if (!value) return neverLabel
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
}

export function RemotePage({
  standalone = false
}: { standalone?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const isMac = /Mac/.test(navigator.userAgent)
  const section = useUIStore((state) => state.remoteWorkspaceSection)
  const setSection = useUIStore((state) => state.setRemoteWorkspaceSection)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RemoteConnection | null>(null)
  const [saving, setSaving] = useState(false)
  const [connectAfterSave, setConnectAfterSave] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>(() => [
    { id: 'workspace-initial', kind: section, title: '' }
  ])
  const [activeSurface, setActiveSurface] = useState<string>('workspace:workspace-initial')
  const sshTabs = useSshStore((state) => state.openTabs)
  const sshActiveTabId = useSshStore((state) => state.activeTabId)
  const previousSshTabCountRef = useRef(sshTabs.length)
  const sshSessions = useSshStore((state) => state.sessions)

  const connections = useRemoteStore((state) => state.connections)
  const sessions = useRemoteStore((state) => state.sessions)
  const loadingConnections = useRemoteStore((state) => state.loadingConnections)
  const connectingConnectionId = useRemoteStore((state) => state.connectingConnectionId)
  const testingConnectionId = useRemoteStore((state) => state.testingConnectionId)
  const loadConnections = useRemoteStore((state) => state.loadConnections)
  const loadSessions = useRemoteStore((state) => state.loadSessions)
  const createConnection = useRemoteStore((state) => state.createConnection)
  const updateConnection = useRemoteStore((state) => state.updateConnection)
  const deleteConnection = useRemoteStore((state) => state.deleteConnection)
  const testConnection = useRemoteStore((state) => state.testConnection)
  const connect = useRemoteStore((state) => state.connect)
  const disconnect = useRemoteStore((state) => state.disconnect)

  const selectSshSession = (tabId: string): void => {
    useSshStore.getState().setActiveTab(tabId)
    setSection('ssh')
    setActiveSurface(`ssh:${tabId}`)
  }

  const workspaceTitle = useCallback(
    (kind: WorkspaceKind): string =>
      ({
        ssh: t('remote.sshWorkspace'),
        direct: t('remote.directConnection'),
        managed: t('remote.managedDevices'),
        mobile: t('remote.mobileControl')
      })[kind],
    [t]
  )

  const addWorkspace = (kind: WorkspaceKind): void => {
    const id = `workspace-${kind}-${Date.now()}`
    setWorkspaceTabs((tabs) => [...tabs, { id, kind, title: workspaceTitle(kind) }])
    setSection(kind)
    setActiveSurface(`workspace:${id}`)
    setLauncherOpen(false)
  }

  useEffect(() => {
    void Promise.all([loadConnections(), loadSessions()])
  }, [loadConnections, loadSessions])

  useEffect(() => {
    if (sshTabs.length > previousSshTabCountRef.current && sshActiveTabId) {
      setSection('ssh')
      setActiveSurface(`ssh:${sshActiveTabId}`)
    }
    previousSshTabCountRef.current = sshTabs.length
  }, [setSection, sshActiveTabId, sshTabs.length])

  const directConnections = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return connections
      .filter((connection) => connection.kind === 'rdp' || connection.kind === 'vnc')
      .filter(
        (connection) =>
          !normalized ||
          connection.name.toLowerCase().includes(normalized) ||
          connection.host?.toLowerCase().includes(normalized) ||
          connection.username?.toLowerCase().includes(normalized)
      )
      .sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0))
  }, [connections, query])

  const sessionByConnection = useMemo(
    () =>
      new Map(
        sessions
          .filter((session) => session.status === 'connected' || session.status === 'connecting')
          .map((session) => [session.connectionId, session])
      ),
    [sessions]
  )
  const viewerSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          (session.status === 'connected' || session.status === 'connecting') && session.viewerUrl
      ),
    [sessions]
  )
  const activeSession =
    viewerSessions.find((session) => session.id === activeSessionId) ?? viewerSessions[0] ?? null

  useEffect(() => {
    if (activeSession && activeSession.id !== activeSessionId) setActiveSessionId(activeSession.id)
    if (!activeSession) setActiveSessionId(null)
  }, [activeSession, activeSessionId])

  useEffect(() => {
    const onFullscreenChange = (): void => setFullscreen(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const toggleFullscreen = async (): Promise<void> => {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await workspaceRef.current?.requestFullscreen()
  }

  const editConnection = (connection: RemoteConnection): void => {
    if (connection.kind !== 'rdp' && connection.kind !== 'vnc') return
    setEditor({
      id: connection.id,
      kind: connection.kind,
      name: connection.name,
      host: connection.host ?? '',
      port: String(connection.port ?? (connection.kind === 'rdp' ? 3389 : 5900)),
      username: connection.username ?? '',
      domain: connection.rdp?.domain ?? '',
      password: ''
    })
  }

  const changeKind = (kind: DirectKind): void => {
    setEditor((current) => ({
      ...(current ?? emptyEditor(kind)),
      kind,
      port: kind === 'rdp' ? '3389' : '5900',
      domain: kind === 'rdp' ? (current?.domain ?? '') : ''
    }))
  }

  const saveEditor = async (shouldConnect: boolean): Promise<void> => {
    if (!editor) return
    const host = editor.host.trim()
    const port = Number(editor.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t('remote.connectionRequired'))
      return
    }
    if (editor.kind === 'rdp' && (!editor.username.trim() || (!editor.id && !editor.password))) {
      toast.error(t('remote.rdpCredentialRequired'))
      return
    }
    setSaving(true)
    setConnectAfterSave(shouldConnect)
    try {
      const name = editor.name.trim() || host
      const connection = editor.id
        ? await updateConnection({
            id: editor.id,
            password: editor.password || null,
            patch: {
              name,
              host,
              port,
              username: editor.username.trim() || null,
              rdp:
                editor.kind === 'rdp'
                  ? { launchMode: 'embedded', domain: editor.domain.trim() || null }
                  : null,
              vnc: editor.kind === 'vnc' ? { launchMode: 'novnc' } : null
            }
          })
        : await createConnection({
            kind: editor.kind,
            name,
            host,
            port,
            username: editor.username.trim() || null,
            password: editor.password || null,
            rdp:
              editor.kind === 'rdp'
                ? { launchMode: 'embedded', domain: editor.domain.trim() || null }
                : null,
            vnc: editor.kind === 'vnc' ? { launchMode: 'novnc' } : null
          })
      setEditor(null)
      toast.success(editor.id ? t('remote.connectionUpdated') : t('remote.connectionSaved'))
      if (shouldConnect) {
        const session = await connect(connection.id)
        setActiveSessionId(session.id)
        setActiveSurface(`remote:${session.id}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
      setConnectAfterSave(false)
    }
  }

  const runTest = async (connection: RemoteConnection): Promise<void> => {
    try {
      const result = await testConnection(connection.id)
      if (result.success) {
        toast.success(
          t('remote.testReachable', {
            latency: result.latencyMs ?? 0
          })
        )
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const runConnect = async (connection: RemoteConnection): Promise<void> => {
    try {
      const session = await connect(connection.id)
      setActiveSessionId(session.id)
      setActiveSurface(`remote:${session.id}`)
      toast.success(t('remote.sessionStarted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      const session = sessionByConnection.get(deleteTarget.id)
      if (session) await disconnect(session.id)
      await deleteConnection(deleteTarget.id)
      setDeleteTarget(null)
      toast.success(t('remote.connectionDeleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div ref={workspaceRef} className="flex h-full min-h-0 flex-col bg-background">
      <header
        className={`titlebar-drag relative flex h-12 shrink-0 items-end border-b pr-4 ${fullscreen ? 'hidden' : ''} ${
          standalone && isMac ? 'pl-[78px]' : 'pl-3'
        }`}
      >
        <div className="titlebar-no-drag flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {workspaceTabs.map((tab) => {
            const active = activeSurface === `workspace:${tab.id}`
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setSection(tab.kind)
                  setActiveSurface(`workspace:${tab.id}`)
                }}
                className={`group flex h-10 min-w-[150px] max-w-[220px] items-center gap-2 rounded-t-lg border border-b-0 px-3 text-xs transition-colors ${
                  active
                    ? 'bg-background text-foreground'
                    : 'border-transparent bg-muted/35 text-muted-foreground hover:bg-muted/65'
                }`}
              >
                {tab.kind === 'ssh' ? <Terminal className="size-3.5" /> : null}
                {tab.kind === 'direct' ? <Cable className="size-3.5" /> : null}
                {tab.kind === 'managed' ? <Server className="size-3.5" /> : null}
                {tab.kind === 'mobile' ? <Smartphone className="size-3.5" /> : null}
                <span className="min-w-0 flex-1 truncate">
                  {tab.title || workspaceTitle(tab.kind)}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    setWorkspaceTabs((tabs) => tabs.filter((item) => item.id !== tab.id))
                    if (active) setActiveSurface('')
                  }}
                >
                  <X className="size-3" />
                </span>
              </button>
            )
          })}
          {sshTabs.map((tab) => {
            const session = tab.sessionId ? sshSessions[tab.sessionId] : null
            const active = activeSurface === `ssh:${tab.id}`
            return (
              <button
                key={`ssh-${tab.id}`}
                type="button"
                onClick={() => selectSshSession(tab.id)}
                className={`group flex h-9 min-w-[150px] max-w-[240px] items-center gap-2 rounded-t-lg border border-b-0 px-3 text-xs transition-colors ${
                  active
                    ? 'bg-background text-foreground'
                    : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                }`}
              >
                <Terminal className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    session?.status === 'connected'
                      ? 'bg-emerald-500'
                      : session?.status === 'connecting' || tab.status === 'connecting'
                        ? 'animate-pulse bg-amber-500'
                        : 'bg-muted-foreground/40'
                  }`}
                />
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    useSshStore.getState().closeTab(tab.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      useSshStore.getState().closeTab(tab.id)
                    }
                  }}
                >
                  <X className="size-3" />
                </span>
              </button>
            )
          })}
          {viewerSessions.map((session) => {
            const connection = connections.find((item) => item.id === session.connectionId)
            const active = activeSurface === `remote:${session.id}`
            return (
              <button
                key={`remote-${session.id}`}
                type="button"
                onClick={() => {
                  setActiveSessionId(session.id)
                  setSection('direct')
                  setActiveSurface(`remote:${session.id}`)
                }}
                className={`group flex h-9 min-w-[150px] max-w-[240px] items-center gap-2 rounded-t-lg border border-b-0 px-3 text-xs transition-colors ${
                  active
                    ? 'bg-background text-foreground'
                    : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                }`}
              >
                {session.viewerType === 'rdp' ? (
                  <Monitor className="size-3.5 shrink-0" />
                ) : (
                  <Laptop className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {connection?.name ?? session.viewerDestination}
                </span>
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    void disconnect(session.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') void disconnect(session.id)
                  }}
                >
                  <X className="size-3" />
                </span>
              </button>
            )
          })}
        </div>
        <div className="titlebar-no-drag relative mb-1 ml-1 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLauncherOpen((open) => !open)}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('remote.newSession')}
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Maximize2 className="size-4" />
          </button>
          {launcherOpen ? (
            <div className="absolute right-0 top-10 z-50 w-72 overflow-hidden rounded-xl border bg-popover p-2 text-popover-foreground shadow-2xl">
              {(
                [
                  ['ssh', Terminal, t('remote.sshWorkspace')],
                  ['direct', Cable, t('remote.directConnection')],
                  ['managed', Server, t('remote.managedDevices')],
                  ['mobile', Smartphone, t('remote.mobileControl')]
                ] as const
              ).map(([kind, Icon, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addWorkspace(kind)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-muted"
                >
                  <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-4" />
                  </span>
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {fullscreen ? (
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className="fixed right-4 top-4 z-[70] inline-flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/65 text-white shadow-lg backdrop-blur hover:bg-black/80"
          title={t('remote.exitFullscreen')}
        >
          <Minimize2 className="size-4" />
        </button>
      ) : null}

      <div
        className={
          section === 'ssh' &&
          (activeSurface.startsWith('workspace:') || activeSurface.startsWith('ssh:'))
            ? 'min-h-0 flex-1'
            : 'hidden'
        }
      >
        <SshPage embedded />
      </div>

      <div
        className={
          section === 'direct' &&
          (activeSurface.startsWith('workspace:') || activeSurface.startsWith('remote:'))
            ? 'flex min-h-0 flex-1'
            : 'hidden'
        }
      >
        <aside
          className={`${fullscreen || activeSurface.startsWith('remote:') ? 'hidden' : 'flex'} w-[350px] shrink-0 flex-col border-r bg-muted/10`}
        >
          <div className="border-b p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder={t('remote.searchDevices')}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-4 pb-2 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <span>{t('remote.savedDevices')}</span>
              <span>{directConnections.length}</span>
            </div>
            {loadingConnections ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : directConnections.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <CircleOff className="mx-auto size-7 text-muted-foreground/60" />
                <p className="mt-3 text-sm font-medium">{t('remote.noSavedDevices')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('remote.noSavedDevicesHint')}
                </p>
              </div>
            ) : (
              <div className="pb-4">
                {directConnections.map((connection) => {
                  const session = sessionByConnection.get(connection.id)
                  const connecting = connectingConnectionId === connection.id
                  return (
                    <div
                      key={connection.id}
                      className="group border-b px-4 py-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          {connectionIcon(connection.kind)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{connection.name}</span>
                            {session ? (
                              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                            ) : null}
                          </div>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                            {connection.host}:{connection.port}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => editConnection(connection)}
                          className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                          title={t('remote.editDevice')}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      </div>
                      <div className="mt-3 flex items-center justify-between pl-12">
                        <span className="text-[11px] text-muted-foreground">
                          {connection.kind.toUpperCase()} ·{' '}
                          {formatLastConnected(
                            connection.lastConnectedAt,
                            t('remote.neverConnected')
                          )}
                        </span>
                        {session ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => void disconnect(session.id)}
                          >
                            <Power className="mr-1.5 size-3" />
                            {t('remote.disconnectSignaling')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={connecting}
                            onClick={() => void runConnect(connection)}
                          >
                            {connecting ? (
                              <Loader2 className="mr-1.5 size-3 animate-spin" />
                            ) : (
                              <Power className="mr-1.5 size-3" />
                            )}
                            {t('remote.connect')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {activeSession ? (
            <DirectSessionWorkspace
              sessions={viewerSessions}
              activeSessionId={activeSession.id}
              connections={connections}
              onSelect={setActiveSessionId}
              onDisconnect={(sessionId) => void disconnect(sessionId)}
            />
          ) : (
            <DirectOverview
              onAdd={(kind) => setEditor(emptyEditor(kind))}
              recent={directConnections.slice(0, 3)}
              onConnect={(connection) => void runConnect(connection)}
            />
          )}
        </main>
      </div>

      <div
        className={
          section === 'managed' && activeSurface.startsWith('workspace:')
            ? 'min-h-0 flex-1'
            : 'hidden'
        }
      >
        <FutureWorkspace
          icon={Server}
          eyebrow={t('remote.remoteService')}
          title={t('remote.managedTitle')}
          description={t('remote.managedDescription')}
          points={[
            t('remote.managedPointOne'),
            t('remote.managedPointTwo'),
            t('remote.managedPointThree')
          ]}
          action={t('remote.configureServiceLater')}
        />
      </div>
      <div
        className={
          section === 'mobile' && activeSurface.startsWith('workspace:')
            ? 'min-h-0 flex-1'
            : 'hidden'
        }
      >
        <FutureWorkspace
          icon={Smartphone}
          eyebrow={t('remote.crossPlatform')}
          title={t('remote.mobileTitle')}
          description={t('remote.mobileDescription')}
          points={[
            t('remote.mobilePointOne'),
            t('remote.mobilePointTwo'),
            t('remote.mobilePointThree')
          ]}
          action={t('remote.mobileAppLater')}
        />
      </div>

      {editor ? (
        <ConnectionEditor
          value={editor}
          saving={saving}
          connecting={connectAfterSave}
          onChange={setEditor}
          onKindChange={changeKind}
          onClose={() => setEditor(null)}
          onSave={() => void saveEditor(false)}
          onSaveAndConnect={() => void saveEditor(true)}
          onTest={
            editor.id
              ? () => {
                  const connection = connections.find((item) => item.id === editor.id)
                  if (connection) void runTest(connection)
                }
              : undefined
          }
          testing={editor.id === testingConnectionId}
          onDelete={
            editor.id
              ? () => {
                  const connection = connections.find((item) => item.id === editor.id)
                  if (connection) setDeleteTarget(connection)
                }
              : undefined
          }
        />
      ) : null}

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6 backdrop-blur-[2px]">
          <div className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-2xl">
            <div className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <Trash2 className="size-4" />
            </div>
            <h2 className="mt-4 text-base font-semibold">{t('remote.deleteDeviceTitle')}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t('remote.deleteDeviceDescription', { name: deleteTarget.name })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                {t('remote.deleteDevice')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DirectOverview({
  onAdd,
  recent,
  onConnect
}: {
  onAdd: (kind: DirectKind) => void
  recent: RemoteConnection[]
  onConnect: (connection: RemoteConnection) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <div className="max-w-2xl">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Globe2 className="size-5" />
        </div>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight">{t('remote.directTitle')}</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          {t('remote.directDescription')}
        </p>
      </div>

      <div className="mt-10 grid grid-cols-2 divide-x overflow-hidden rounded-xl border">
        <button
          type="button"
          onClick={() => onAdd('rdp')}
          className="group p-6 text-left transition-colors hover:bg-muted/40"
        >
          <div className="flex items-center justify-between">
            <Monitor className="size-5 text-primary" />
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </div>
          <h3 className="mt-7 text-sm font-semibold">{t('remote.windowsRdp')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('remote.windowsRdpHint')}
          </p>
        </button>
        <button
          type="button"
          onClick={() => onAdd('vnc')}
          className="group p-6 text-left transition-colors hover:bg-muted/40"
        >
          <div className="flex items-center justify-between">
            <Laptop className="size-5 text-primary" />
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </div>
          <h3 className="mt-7 text-sm font-semibold">{t('remote.macVnc')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('remote.macVncHint')}</p>
        </button>
      </div>

      {recent.length > 0 ? (
        <section className="mt-10">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('remote.recentDevices')}
          </h3>
          <div className="mt-3 divide-y border-y">
            {recent.map((connection) => (
              <button
                key={connection.id}
                type="button"
                onClick={() => onConnect(connection)}
                className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <span className="text-muted-foreground">{connectionIcon(connection.kind)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{connection.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {connection.host}:{connection.port}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function DirectSessionWorkspace({
  sessions,
  activeSessionId,
  connections,
  onSelect,
  onDisconnect
}: {
  sessions: RemoteSession[]
  activeSessionId: string
  connections: RemoteConnection[]
  onSelect: (sessionId: string) => void
  onDisconnect: (sessionId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div className="flex h-full min-h-[520px] flex-col bg-zinc-950">
      <div className="hidden">
        {sessions.map((session) => {
          const connection = connections.find((item) => item.id === session.connectionId)
          const active = session.id === activeSessionId
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={`group flex h-8 min-w-[150px] max-w-[240px] items-center gap-2 rounded-md px-3 text-left text-xs transition-colors ${
                active
                  ? 'bg-white/12 text-white'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
              }`}
            >
              {session.viewerType === 'rdp' ? (
                <Monitor className="size-3.5 shrink-0" />
              ) : (
                <Laptop className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {connection?.name ?? session.viewerDestination}
              </span>
              <span
                role="button"
                tabIndex={0}
                title={t('remote.disconnectSignaling')}
                className="rounded p-0.5 opacity-0 hover:bg-white/10 group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  onDisconnect(session.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onDisconnect(session.id)
                }}
              >
                <Power className="size-3" />
              </span>
            </button>
          )
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={
              session.id === activeSessionId ? 'absolute inset-0' : 'invisible absolute inset-0'
            }
          >
            <ActiveViewer
              session={session}
              connection={connections.find((item) => item.id === session.connectionId)}
              onDisconnect={() => onDisconnect(session.id)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function ActiveViewer({
  session,
  connection,
  onDisconnect
}: {
  session: RemoteSession
  connection?: RemoteConnection
  onDisconnect: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [viewerStatus, setViewerStatus] = useState<
    'connecting' | 'connected' | 'disconnected' | 'error'
  >('connecting')
  const updateViewerStatus = useCallback(
    (status: 'connecting' | 'connected' | 'disconnected' | 'error') => {
      setViewerStatus(status)
    },
    []
  )
  return (
    <div className="flex min-h-full flex-col bg-zinc-950">
      <div className="flex items-center justify-between border-b border-white/10 bg-zinc-950 px-4 py-2 text-white">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`size-2 rounded-full ${
              viewerStatus === 'connected'
                ? 'bg-emerald-400'
                : viewerStatus === 'error'
                  ? 'bg-red-400'
                  : 'animate-pulse bg-amber-400'
            }`}
          />
          <span className="truncate text-sm font-medium">
            {connection?.name ?? session.viewerDestination}
          </span>
          <span className="hidden font-mono text-xs text-zinc-400 md:inline">
            {session.viewerDestination}
          </span>
        </div>
        <Button size="sm" variant="secondary" onClick={onDisconnect}>
          <Power className="mr-2 size-3.5" />
          {t('remote.disconnectSignaling')}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {session.viewerType === 'rdp' ? (
          <IronRdpViewer remoteSession={session} onStatusChange={updateViewerStatus} />
        ) : (
          <NoVncViewer
            sessionId={session.id}
            viewerUrl={session.viewerUrl as string}
            onStatusChange={updateViewerStatus}
          />
        )}
      </div>
    </div>
  )
}

function ConnectionEditor({
  value,
  saving,
  connecting,
  testing,
  onChange,
  onKindChange,
  onClose,
  onSave,
  onSaveAndConnect,
  onTest,
  onDelete
}: {
  value: EditorState
  saving: boolean
  connecting: boolean
  testing: boolean
  onChange: (value: EditorState) => void
  onKindChange: (kind: DirectKind) => void
  onClose: () => void
  onSave: () => void
  onSaveAndConnect: () => void
  onTest?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const update = (patch: Partial<EditorState>): void => onChange({ ...value, ...patch })
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/25 backdrop-blur-[1px]">
      <button type="button" className="min-w-0 flex-1" onClick={onClose} aria-label={t('close')} />
      <aside className="flex h-full w-full max-w-[440px] flex-col border-l bg-background shadow-2xl">
        <div className="flex items-start justify-between border-b px-6 py-5">
          <div>
            <h2 className="text-base font-semibold">
              {value.id ? t('remote.editDevice') : t('remote.addDevice')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('remote.editorHint')}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <MoreHorizontal className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('remote.deviceType')}
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              variant={value.kind === 'rdp' ? 'default' : 'outline'}
              disabled={Boolean(value.id)}
              onClick={() => onKindChange('rdp')}
            >
              <Monitor className="mr-2 size-4" /> Windows
            </Button>
            <Button
              variant={value.kind === 'vnc' ? 'default' : 'outline'}
              disabled={Boolean(value.id)}
              onClick={() => onKindChange('vnc')}
            >
              <Laptop className="mr-2 size-4" /> macOS
            </Button>
          </div>

          <div className="mt-6 space-y-5">
            <Field label={t('remote.deviceName')} hint={t('remote.deviceNameHint')}>
              <Input
                value={value.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t('remote.namePlaceholder')}
              />
            </Field>
            <div className="grid grid-cols-[1fr_100px] gap-3">
              <Field label={t('remote.address')}>
                <Input
                  value={value.host}
                  onChange={(event) => update({ host: event.target.value })}
                  placeholder={t('remote.hostPlaceholder')}
                />
              </Field>
              <Field label={t('remote.portPlaceholder')}>
                <Input
                  value={value.port}
                  inputMode="numeric"
                  onChange={(event) => update({ port: event.target.value })}
                />
              </Field>
            </div>

            <div className="border-t pt-5">
              <div className="mb-4 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                {t('remote.authentication')}
              </div>
              <div className="space-y-4">
                <Field label={t('remote.username')}>
                  <Input
                    value={value.username}
                    onChange={(event) => update({ username: event.target.value })}
                    autoComplete="off"
                    placeholder={t('remote.usernamePlaceholder')}
                  />
                </Field>
                {value.kind === 'rdp' ? (
                  <Field label={t('remote.windowsDomain')} hint={t('remote.optional')}>
                    <Input
                      value={value.domain}
                      onChange={(event) => update({ domain: event.target.value })}
                      placeholder={t('remote.domainPlaceholder')}
                    />
                  </Field>
                ) : null}
                <Field
                  label={t('remote.password')}
                  hint={value.id ? t('remote.passwordKeepHint') : t('remote.vaultHint')}
                >
                  <Input
                    value={value.password}
                    type="password"
                    autoComplete="new-password"
                    onChange={(event) => update({ password: event.target.value })}
                    placeholder={value.id ? '••••••••' : t('remote.connectionPasswordPlaceholder')}
                  />
                </Field>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t px-6 py-4">
          {value.id ? (
            <div className="mb-3 flex items-center justify-between">
              <Button variant="ghost" size="sm" disabled={testing} onClick={onTest}>
                {testing ? (
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                ) : (
                  <Wifi className="mr-2 size-3.5" />
                )}
                {t('remote.testConnection')}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
                <Trash2 className="mr-2 size-3.5" />
                {t('remote.deleteDevice')}
              </Button>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={saving} onClick={onSave}>
              {saving && !connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t('remote.saveDevice')}
            </Button>
            <Button disabled={saving} onClick={onSaveAndConnect}>
              {saving && connecting ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Power className="mr-2 size-4" />
              )}
              {t('remote.saveAndConnect')}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-2 flex items-center justify-between text-xs font-medium">
        {label}
        {hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

function FutureWorkspace({
  icon: Icon,
  eyebrow,
  title,
  description,
  points,
  action
}: {
  icon: typeof Server
  eyebrow: string
  title: string
  description: string
  points: string[]
  action: string
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-10 py-14">
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-primary">
          <Icon className="size-4" /> {eyebrow}
        </div>
        <h2 className="mt-5 max-w-2xl text-3xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">{description}</p>
        <div className="mt-10 border-y">
          {points.map((point, index) => (
            <div key={point} className="flex items-center gap-4 border-b py-4 last:border-b-0">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {index + 1}
              </span>
              <span className="text-sm">{point}</span>
              <CheckCircle2 className="ml-auto size-4 text-muted-foreground/50" />
            </div>
          ))}
        </div>
        <div className="mt-8 flex items-center gap-3">
          <Button disabled>{action}</Button>
          <span className="text-xs text-muted-foreground">{t('remote.plannedFeature')}</span>
        </div>
      </div>
    </div>
  )
}
