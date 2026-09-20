import * as path from 'path'
import { businessWriteCanary } from '../db/business-write-canary'
import { olaDataRoot } from '../lib/ola-data-root'
import { readChannelPlugins } from './channel-config-store'
import { ChannelTaskInbox } from './channel-task-inbox'
import { authorizeChannelSessionWorkspace } from './channel-session-workspace'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { safeSendMessagePackToWorkspaceWindow } from '../window-ipc'
import type { ChannelEvent, ChannelInstance, ChannelIncomingMessageData } from './channel-types'
import type { ChannelManager } from './channel-manager'
import { tryHandleCommand } from './plugin-commands'

let _pluginManager: ChannelManager | null = null
let channelTaskInbox: ChannelTaskInbox | null = null
const deliveryChains = new Map<string, Promise<void>>()
const retryTimers = new Map<string, NodeJS.Timeout>()
const activeRoutes = new Set<Promise<void>>()
let quiescingForHandover = false

function getChannelTaskInbox(): ChannelTaskInbox {
  channelTaskInbox ??= new ChannelTaskInbox(path.join(olaDataRoot(), 'channel-task-inbox.sqlite'))
  return channelTaskInbox
}

export function closeChannelTaskInbox(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer)
  retryTimers.clear()
  channelTaskInbox?.close()
  channelTaskInbox = null
}

function schedulePendingTaskRetry(workspaceId: string): void {
  if (quiescingForHandover) return
  if (retryTimers.has(workspaceId)) return
  const delay = getChannelTaskInbox().nextRetryDelayMs(workspaceId)
  if (delay === null) return
  // Missing plugins or malformed legacy payloads must not create a hot retry loop.
  const timer = setTimeout(
    () => {
      retryTimers.delete(workspaceId)
      void flushPendingChannelTasks(workspaceId).catch((error) => {
        console.warn('[AutoReply] Pending task retry failed:', error)
      })
    },
    delay === 0 ? 30_000 : Math.max(1_000, delay)
  )
  timer.unref()
  retryTimers.set(workspaceId, timer)
}

export function acknowledgeChannelTaskDelivery(workspaceId: string, deliveryId: string): boolean {
  return getChannelTaskInbox().markDelivered(deliveryId, workspaceId)
}

export function flushPendingChannelTasks(workspaceId: string): Promise<void> {
  if (quiescingForHandover) return Promise.reject(new Error('CHANNEL_HANDOVER_QUIESCED'))
  const previous = deliveryChains.get(workspaceId) ?? Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(async () => {
      await authorizeChannelSessionWorkspace(workspaceId, loadOfflineWorkspaceIds)
      const inbox = getChannelTaskInbox()
      let afterSequence = 0
      try {
        for (;;) {
          const pending = inbox.pending(workspaceId, 100, afterSequence)
          if (pending.length === 0) return
          for (const item of pending) {
            afterSequence = item.sequence
            await authorizeChannelSessionWorkspace(workspaceId, loadOfflineWorkspaceIds)
            const plugin = (await readChannelPlugins()).find(
              (candidate) => candidate.id === item.pluginId
            )
            if (!plugin || (plugin.workspaceId || 'local-personal') !== workspaceId) continue
            if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload))
              continue
            const task = { ...item.payload, deliveryId: item.id }
            if (!safeSendMessagePackToWorkspaceWindow(workspaceId, 'plugin:session-task', task)) {
              console.warn(`[AutoReply] Task queued until a ${workspaceId} main window is ready`)
              return
            }
            inbox.markSent(item.id, workspaceId)
          }
        }
      } finally {
        schedulePendingTaskRetry(workspaceId)
      }
    })
  deliveryChains.set(workspaceId, current)
  void current
    .finally(() => {
      if (deliveryChains.get(workspaceId) === current) deliveryChains.delete(workspaceId)
    })
    .catch(() => {})
  return current
}

/** Must be called once at startup to wire the plugin manager */
export function setPluginManager(pm: ChannelManager): void {
  _pluginManager = pm
}

/**
 * Auto-reply pipeline: routes incoming plugin messages to per-user/per-group sessions
 * and notifies the renderer to trigger the Agent Loop for auto-reply.
 */
export function handleChannelAutoReply(event: ChannelEvent): void {
  if (quiescingForHandover) throw new Error('CHANNEL_HANDOVER_QUIESCED')
  const route = handleChannelAutoReplyAsync(event)
  activeRoutes.add(route)
  void route.finally(() => activeRoutes.delete(route)).catch(() => undefined)
}

/** Drain accepted channel routes after providers have stopped emitting messages. */
export async function quiesceChannelAutoReplyForHandover(timeoutMs = 30_000): Promise<void> {
  quiescingForHandover = true
  for (const timer of retryTimers.values()) clearTimeout(timer)
  retryTimers.clear()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const drain = async () => {
    const routes = await Promise.allSettled([...activeRoutes])
    // Routes can schedule deliveries while draining, so snapshot deliveries only afterward.
    const deliveries = await Promise.allSettled([...deliveryChains.values()])
    return { routes, deliveries }
  }
  const { routes, deliveries } = await Promise.race([
    drain(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('CHANNEL_HANDOVER_DRAIN_TIMEOUT')), timeoutMs)
    })
  ]).finally(() => clearTimeout(timeout))
  if (
    routes.some((result) => result.status === 'rejected') ||
    deliveries.some((result) => result.status === 'rejected')
  )
    throw new Error('CHANNEL_HANDOVER_ROUTE_FAILED')
  if (getChannelTaskInbox().pendingCount() > 0)
    throw new Error('CHANNEL_TASKS_PENDING_DURING_HANDOVER')
}

export async function quiesceChannelsForHandover(): Promise<void> {
  await _pluginManager?.quiesceForHandover()
  await quiesceChannelAutoReplyForHandover()
}

/** Reopen channel ingress after an explicitly enabled successful handover. */
export async function resumeChannelsAfterHandover(): Promise<void> {
  quiescingForHandover = false
  await _pluginManager?.resumeAfterHandover()
}

async function handleChannelAutoReplyAsync(event: ChannelEvent): Promise<void> {
  if (event.type !== 'incoming_message') return

  const data = event.data as ChannelIncomingMessageData
  if (!data || !data.chatId || (!data.content && !data.images?.length && !data.audio)) return

  const pluginId = event.pluginId

  try {
    const plugins = await readChannelPlugins()
    const pluginInstance: ChannelInstance | undefined = plugins.find((p) => p.id === pluginId)
    if (!pluginInstance) throw new Error('CHANNEL_PLUGIN_NOT_FOUND')
    const workspaceId = await authorizeChannelSessionWorkspace(
      pluginInstance.workspaceId,
      loadOfflineWorkspaceIds
    )

    const routeInput = {
      pluginId,
      chatId: data.chatId,
      chatName: data.chatName ?? null,
      senderName: data.senderName ?? null,
      projectId: pluginInstance?.projectId ?? null,
      workspaceId,
      providerId: pluginInstance?.providerId ?? null,
      modelId: pluginInstance?.model ?? null,
      modelSource: pluginInstance?.modelSource ? JSON.stringify(pluginInstance.modelSource) : null
    }
    const writer = businessWriteCanary()
    if (!writer) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
    const routedSession = await writer.routeChannelSession(routeInput)

    if (!routedSession.sessionId) throw new Error('Plugin session routing returned no session')

    const sessionId = routedSession.sessionId
    const sessionTitle =
      routedSession.sessionTitle || data.chatName || data.senderName || data.chatId
    const pluginWorkDir = routedSession.workingFolder ?? ''
    const pluginSshConnectionId = routedSession.sshConnectionId ?? null

    // ── Command interception: handle /help, /new, /init, /status etc. before agent loop ──
    // Always attempt command parsing — tryHandleCommand handles @mention stripping internally
    if (_pluginManager && data.content?.trim()) {
      const commandResult = await tryHandleCommand({
        pluginId,
        pluginType: event.pluginType,
        chatId: data.chatId,
        data,
        sessionId,
        workspaceId,
        pluginWorkDir,
        pluginManager: _pluginManager
      })
      // true = fully handled, skip agent loop
      if (commandResult === true) return
      // string = command rewrote the message, pass to agent loop with new content
      if (typeof commandResult === 'string') {
        data.content = commandResult
      }
      // false = not a command, proceed with original content
    }

    if (pluginInstance.features?.autoReply === false) return

    // NOTE: We do NOT insert the user message here — the renderer's sendMessage
    // will handle it (via triggerSendMessage) to avoid duplicate messages and
    // ensure proper multi-modal content handling.

    // Check if the plugin service supports streaming
    const service = _pluginManager?.getService(pluginId)
    const supportsStreaming = !!(service?.supportsStreaming && service?.sendStreamingMessage)

    // Notify renderer to trigger Agent Loop auto-reply
    const taskPayload = {
      sessionId,
      pluginId,
      pluginType: event.pluginType,
      chatId: data.chatId,
      senderId: data.senderId,
      senderName: data.senderName,
      chatName: data.chatName,
      sessionTitle,
      content:
        data.content ||
        (data.images?.length ? '[User sent an image]' : '') ||
        (data.audio ? '[User sent an audio message]' : ''),
      messageId: data.messageId,
      workspaceId,
      supportsStreaming,
      images: data.images,
      audio: data.audio,
      chatType: data.chatType,
      projectId: routedSession.projectId ?? undefined,
      workingFolder: pluginWorkDir || undefined,
      sshConnectionId: pluginSshConnectionId
    }
    await authorizeChannelSessionWorkspace(workspaceId, loadOfflineWorkspaceIds)
    const queued = getChannelTaskInbox().enqueue({
      workspaceId,
      pluginId,
      chatId: data.chatId,
      messageId: data.messageId,
      payload: taskPayload
    })
    if (queued.status === 'pending') await flushPendingChannelTasks(workspaceId)

    console.log(
      `[AutoReply] Saved message from ${data.senderName || data.senderId} ` +
        `in chat ${data.chatId} to session ${sessionId}`
    )
  } catch (err) {
    console.error('[AutoReply] Failed to route incoming message:', err)
    if (quiescingForHandover) throw err
  }
}
