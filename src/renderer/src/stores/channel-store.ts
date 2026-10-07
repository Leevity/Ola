import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { isCurrentChannelSessionResponse } from '@renderer/lib/channel-session-cache'
import { isChannelTaskWorkspaceSwitching } from '@renderer/lib/channel/channel-task-activity'
import type {
  PluginProviderDescriptor,
  PluginInstance,
  PluginIncomingEvent
} from '@renderer/lib/channel/types'
import { IPC } from '@renderer/lib/ipc/channels'

interface ChannelStore {
  channels: PluginInstance[]
  channelsLoaded: boolean
  channelsLoadError: string | null
  providers: PluginProviderDescriptor[]
  selectedChannelId: string | null
  channelStatuses: Record<string, 'running' | 'stopped' | 'error'>
  channelStatusCheckErrors: Record<string, boolean>
  channelStatusCheckedAt: number | null

  // Per-project activation (toggled via + menu)
  activeChannelIdsByProject: Record<string, string[]>

  // Init
  loadProviders: () => Promise<void>
  loadChannels: () => Promise<void>

  // CRUD
  addChannel: (type: string, name: string, config: Record<string, string>) => Promise<string>
  updateChannel: (id: string, patch: Partial<PluginInstance>) => Promise<void>
  removeChannel: (id: string) => Promise<void>
  toggleChannelEnabled: (id: string) => Promise<void>

  // Service control
  startChannel: (id: string) => Promise<string | undefined>
  stopChannel: (id: string) => Promise<void>
  refreshChannelStatus: (id: string) => Promise<void>

  // UI
  setSelectedChannel: (id: string | null) => void

  // Per-project activation
  toggleActiveChannel: (id: string, projectId?: string | null) => void
  clearActiveChannels: (projectId?: string | null) => void
  getActiveChannelIds: (projectId?: string | null) => string[]

  // Channel sessions
  channelSessions: Record<string, unknown[]>
  loadChannelSessions: (channelId: string) => Promise<void>
  resetChannelSessions: () => void
  resetForWorkspace: () => void

  // Helpers
  getDescriptor: (type: string) => PluginProviderDescriptor | undefined
  getConfiguredChannels: () => PluginInstance[]
  getActiveChannels: () => PluginInstance[]
}

// Use window-level flags so HMR module reloads don't re-register listeners
declare global {
  interface Window {
    __pluginListenerActive?: boolean
    __pluginAutoReplyListenerActive?: boolean
    __pluginDispatchedIds?: Set<string>
    __pluginAcceptedDeliveryIds?: Set<string>
    __pluginActiveDeliveryIds?: Set<string>
  }
}

interface ChannelTaskIdentity {
  workspaceId: string
  pluginId: string
  chatId: string
  messageId?: string
  deliveryId?: string
}

function channelTaskDispatchKey(task: ChannelTaskIdentity): string | null {
  const sourceId = task.messageId || task.deliveryId
  return sourceId ? JSON.stringify([task.workspaceId, task.pluginId, task.chatId, sourceId]) : null
}

export function markChannelTaskAccepted(task: ChannelTaskIdentity): void {
  if (!task.deliveryId) return
  const accepted = (window.__pluginAcceptedDeliveryIds ??= new Set<string>())
  accepted.add(task.deliveryId)
  if (accepted.size > 200) {
    const oldest = accepted.values().next().value
    if (oldest) accepted.delete(oldest)
  }
  void ipcClient
    .invoke(IPC.PLUGIN_SESSION_TASK_ACK, {
      workspaceId: task.workspaceId,
      deliveryId: task.deliveryId
    })
    .catch((error) => console.warn('[Plugin] Failed to acknowledge channel task:', error))
}

export function releaseUnacceptedChannelTask(task: ChannelTaskIdentity): void {
  if (!task.deliveryId) return
  window.__pluginActiveDeliveryIds?.delete(task.deliveryId)
  if (window.__pluginAcceptedDeliveryIds?.has(task.deliveryId)) return
  const key = channelTaskDispatchKey(task)
  if (key) window.__pluginDispatchedIds?.delete(key)
}

export function initChannelEventListener(): void {
  if (window.__pluginListenerActive) return
  window.__pluginListenerActive = true
  if (!window.__pluginDispatchedIds) window.__pluginDispatchedIds = new Set<string>()
  if (!window.__pluginAcceptedDeliveryIds) window.__pluginAcceptedDeliveryIds = new Set<string>()
  if (!window.__pluginActiveDeliveryIds) window.__pluginActiveDeliveryIds = new Set<string>()

  ipcClient.on(IPC.PLUGIN_INCOMING_MESSAGE, (...args: unknown[]) => {
    const data = args[0] as PluginIncomingEvent
    if (!data || !data.pluginId) return
    const currentWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
    const channel = useChannelStore.getState().channels.find((item) => item.id === data.pluginId)
    if (!channel || (channel.workspaceId ?? 'local-personal') !== currentWorkspaceId) return

    if (data.type === 'status_change') {
      const status = data.data as 'running' | 'stopped' | 'error'
      useChannelStore.setState((s) => ({
        channelStatuses: { ...s.channelStatuses, [data.pluginId]: status }
      }))
    }
    if (data.type === 'incoming_message') {
      console.log(`[Plugin:${data.pluginId}] Incoming message:`, data.data)
    }
    if (data.type === 'error') {
      console.error(`[Plugin:${data.pluginId}] Error:`, data.data)
      useChannelStore.setState((s) => ({
        channelStatuses: { ...s.channelStatuses, [data.pluginId]: 'error' }
      }))
    }
  })

  // Listen for auto-reply session tasks from main process
  ipcClient.on(IPC.PLUGIN_SESSION_TASK, (...args: unknown[]) => {
    const task = args[0] as {
      sessionId: string
      pluginId: string
      pluginType: string
      workspaceId: string
      chatId: string
      content: string
      messageId?: string
      deliveryId?: string
      projectId?: string
      workingFolder?: string
      sshConnectionId?: string | null
      chatType?: 'p2p' | 'group'
      audio?: { fileKey: string; fileName?: string; mediaType?: string; durationMs?: number }
    }
    if (
      !task ||
      !task.sessionId ||
      isChannelTaskWorkspaceSwitching() ||
      task.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId ||
      !window.__pluginAutoReplyListenerActive
    )
      return

    if (task.deliveryId && window.__pluginAcceptedDeliveryIds?.has(task.deliveryId)) {
      markChannelTaskAccepted(task)
      return
    }
    if (task.deliveryId && window.__pluginActiveDeliveryIds?.has(task.deliveryId)) return

    // Scope provider message IDs to their workspace, plugin and chat; IDs may repeat elsewhere.
    const messageKey = channelTaskDispatchKey(task)
    if (messageKey) {
      const seen = window.__pluginDispatchedIds!
      if (seen.has(messageKey)) {
        console.log(`[Plugin] Skipping duplicate task for messageId=${task.messageId}`)
        if (task.deliveryId && window.__pluginAcceptedDeliveryIds?.has(task.deliveryId))
          markChannelTaskAccepted(task)
        return
      }
      seen.add(messageKey)
      if (seen.size > 200) {
        const first = seen.values().next().value
        if (first) seen.delete(first)
      }
    }

    if (task.deliveryId) window.__pluginActiveDeliveryIds?.add(task.deliveryId)

    window.dispatchEvent(new CustomEvent('plugin:auto-reply-task', { detail: task }))
  })
}

export const useChannelStore = create<ChannelStore>((set, get) => ({
  channels: [],
  channelsLoaded: false,
  channelsLoadError: null,
  providers: [],
  selectedChannelId: null,
  channelStatuses: {},
  channelStatusCheckErrors: {},
  channelStatusCheckedAt: null,
  activeChannelIdsByProject: {},
  channelSessions: {},

  loadProviders: async () => {
    try {
      const providers = (await ipcClient.invoke(
        IPC.PLUGIN_LIST_PROVIDERS
      )) as PluginProviderDescriptor[]
      set({ providers: Array.isArray(providers) ? providers : [] })
    } catch {
      set({ providers: [] })
    }
  },

  loadChannels: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    set({ channelsLoaded: false, channelsLoadError: null })
    try {
      const plugins = (await ipcClient.invoke(IPC.PLUGIN_LIST, { workspaceId })) as PluginInstance[]
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
      const arr = Array.isArray(plugins) ? plugins : []
      console.log(
        `[ChannelStore] Loaded ${arr.length} plugins:`,
        arr.map((p) => `${p.type}(${p.id})`)
      )
      set({ channels: arr, channelsLoaded: true, channelsLoadError: null })
    } catch (err) {
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
      console.error('[ChannelStore] Failed to load plugins:', err)
      set({
        channels: [],
        channelsLoaded: true,
        channelsLoadError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  addChannel: async (type, name, config) => {
    const id = nanoid()
    const desc = get().providers.find((p) => p.type === type)
    const tools = desc?.tools?.reduce<Record<string, boolean>>((acc, toolName) => {
      acc[toolName] = true
      return acc
    }, {})
    const instance: PluginInstance = {
      id,
      type,
      name,
      enabled: true,
      config,
      createdAt: Date.now(),
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      ...(tools ? { tools } : {})
    }
    await ipcClient.invoke(IPC.PLUGIN_ADD, instance)
    set((s) => ({
      channels: [...s.channels, instance]
    }))
    return id
  },

  updateChannel: async (id, patch) => {
    const channel = get().channels.find((item) => item.id === id)
    if (!channel) throw new Error('Channel not found')
    const normalizedPatch = { ...patch }
    if ('providerId' in patch && patch.providerId == null) {
      normalizedPatch.model = null
    }
    await ipcClient.invoke(IPC.PLUGIN_UPDATE, {
      id,
      workspaceId: channel.workspaceId ?? 'local-personal',
      patch: normalizedPatch
    })
    set((s) => ({
      channels: s.channels.map((p) => {
        if (p.id !== id) return p
        const next = { ...p, ...normalizedPatch }
        if (next.providerId == null) {
          next.model = null
        }
        return next
      })
    }))

    if ('providerId' in normalizedPatch || 'model' in normalizedPatch) {
      const plugin = get().channels.find((p) => p.id === id)
      const providerId = plugin?.providerId ?? null
      const modelId = providerId ? (plugin?.model ?? null) : null
      useChatStore.setState((state) => {
        for (const session of state.sessions) {
          if (session.pluginId !== id) continue
          session.providerId = providerId ?? undefined
          session.modelId = modelId ?? undefined
        }
      })

      const activeSessionId = useChatStore.getState().activeSessionId
      if (activeSessionId) {
        const activeSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        if (activeSession?.pluginId === id && providerId && modelId) {
          const providerStore = useProviderStore.getState()
          if (providerStore.activeProviderId !== providerId) {
            providerStore.setActiveProvider(providerId)
          }
          if (providerStore.activeModelId !== modelId) {
            providerStore.setActiveModel(modelId)
          }
        }
      }
    }

    if ('projectId' in normalizedPatch) {
      const boundProject = normalizedPatch.projectId
        ? useChatStore
            .getState()
            .projects.find((project) => project.id === normalizedPatch.projectId)
        : undefined
      useChatStore.setState((state) => {
        for (const session of state.sessions) {
          if (session.pluginId !== id) continue
          session.projectId = boundProject?.id
          session.workingFolder = boundProject?.workingFolder
          session.sshConnectionId = boundProject?.sshConnectionId
          delete session.promptSnapshot
        }
      })
    }
  },

  removeChannel: async (id) => {
    const channel = get().channels.find((item) => item.id === id)
    if (!channel) throw new Error('Channel not found')
    await ipcClient.invoke(IPC.PLUGIN_REMOVE, {
      pluginId: id,
      workspaceId: channel.workspaceId ?? 'local-personal'
    })
    set((s) => ({
      channels: s.channels.filter((p) => p.id !== id),
      selectedChannelId: s.selectedChannelId === id ? null : s.selectedChannelId,
      activeChannelIdsByProject: Object.fromEntries(
        Object.entries(s.activeChannelIdsByProject).map(([projectId, ids]) => [
          projectId,
          ids.filter((pid) => pid !== id)
        ])
      )
    }))
  },

  toggleChannelEnabled: async (id) => {
    const plugin = get().channels.find((p) => p.id === id)
    if (!plugin) return
    const enabled = !plugin.enabled
    await get().updateChannel(id, { enabled })
    if (!enabled) {
      await get().stopChannel(id)
      set((s) => ({
        activeChannelIdsByProject: Object.fromEntries(
          Object.entries(s.activeChannelIdsByProject).map(([projectId, ids]) => [
            projectId,
            ids.filter((pid) => pid !== id)
          ])
        )
      }))
    }
  },

  startChannel: async (id) => {
    try {
      const channel = get().channels.find((item) => item.id === id)
      if (!channel) return 'Channel not found'
      const res = (await ipcClient.invoke(IPC.PLUGIN_START, {
        pluginId: id,
        workspaceId: channel.workspaceId ?? 'local-personal'
      })) as {
        success: boolean
        error?: string
      }
      if (!res.success) {
        set((s) => ({
          channelStatuses: { ...s.channelStatuses, [id]: 'error' }
        }))
        return res.error ?? 'Unknown error'
      }
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: 'running' }
      }))
      return undefined
    } catch (err) {
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: 'error' }
      }))
      return err instanceof Error ? err.message : String(err)
    }
  },

  stopChannel: async (id) => {
    try {
      const channel = get().channels.find((item) => item.id === id)
      if (!channel) return
      await ipcClient.invoke(IPC.PLUGIN_STOP, {
        pluginId: id,
        workspaceId: channel.workspaceId ?? 'local-personal'
      })
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: 'stopped' }
      }))
    } catch {
      // ignore
    }
  },

  refreshChannelStatus: async (id) => {
    try {
      const channel = get().channels.find((item) => item.id === id)
      if (!channel) return
      const status = (await ipcClient.invoke(IPC.PLUGIN_STATUS, {
        pluginId: id,
        workspaceId: channel.workspaceId ?? 'local-personal'
      })) as 'running' | 'stopped' | 'error'
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: status },
        channelStatusCheckErrors: Object.fromEntries(
          Object.entries(s.channelStatusCheckErrors).filter(([channelId]) => channelId !== id)
        ),
        channelStatusCheckedAt: Date.now()
      }))
    } catch {
      set((s) => ({
        channelStatusCheckErrors: { ...s.channelStatusCheckErrors, [id]: true },
        channelStatusCheckedAt: Date.now()
      }))
    }
  },

  setSelectedChannel: (id) => set({ selectedChannelId: id }),

  getActiveChannelIds: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    return get().activeChannelIdsByProject[resolvedProjectId] ?? []
  },

  toggleActiveChannel: (id, projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    set((s) => {
      const currentIds = s.activeChannelIdsByProject[resolvedProjectId] ?? []
      const isActive = currentIds.includes(id)
      return {
        activeChannelIdsByProject: {
          ...s.activeChannelIdsByProject,
          [resolvedProjectId]: isActive
            ? currentIds.filter((pid) => pid !== id)
            : [...currentIds, id]
        }
      }
    })
  },

  clearActiveChannels: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    set((s) => ({
      activeChannelIdsByProject: {
        ...s.activeChannelIdsByProject,
        [resolvedProjectId]: []
      }
    }))
  },

  loadChannelSessions: async (pluginId) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    try {
      const sessions = (await ipcClient.invoke(IPC.PLUGIN_SESSIONS_LIST, {
        pluginId,
        workspaceId
      })) as unknown[]
      if (
        !isCurrentChannelSessionResponse(
          workspaceId,
          useWorkspaceStore.getState().activeWorkspaceId
        )
      )
        return
      set((s) => ({
        channelSessions: { ...s.channelSessions, [pluginId]: sessions }
      }))
    } catch {
      // ignore
    }
  },

  resetChannelSessions: () => set({ channelSessions: {} }),
  resetForWorkspace: () =>
    set({
      channels: [],
      channelsLoaded: false,
      channelsLoadError: null,
      channelStatuses: {},
      channelStatusCheckErrors: {},
      channelStatusCheckedAt: null,
      selectedChannelId: null,
      activeChannelIdsByProject: {},
      channelSessions: {}
    }),

  getDescriptor: (type) => {
    return get().providers.find((p) => p.type === type)
  },

  getConfiguredChannels: () => {
    return get().channels.filter((p) => p.enabled)
  },

  getActiveChannels: () => {
    const { channels } = get()
    const activeChannelIds = get().getActiveChannelIds()
    return channels.filter((p) => activeChannelIds.includes(p.id))
  }
}))
