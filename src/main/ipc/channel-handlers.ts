import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { downloadSafeRemoteResource, FeishuApi } from '../channels/providers/feishu/feishu-api'
import { nanoid } from 'nanoid'
import { ChannelManager } from '../channels/channel-manager'
import {
  isChannelPluginToolEnabled,
  readChannelPlugins,
  writeChannelPlugins
} from '../channels/channel-config-store'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { CHANNEL_PROVIDERS } from '../channels/channel-descriptors'
import { businessWriteCanary } from '../db/business-write-canary'
import {
  authorizeChannelSessionWorkspace,
  readAuthorizedChannelSession
} from '../channels/channel-session-workspace'
import {
  authorizeChannelPluginWorkspace,
  authorizeChannelStreamWorkspace,
  channelPluginInWorkspace,
  loadAuthorizedChannelPlugin
} from '../channels/channel-plugin-workspace'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { handleChannelAutoReply } from '../channels/auto-reply'
import type {
  ChannelInstance,
  ChannelEvent,
  ChannelProviderDescriptor,
  MessagingChannelService
} from '../channels/channel-types'
import {
  legacyModelSource,
  modelSourceSelection,
  parseModelSource,
  type ModelSource
} from '../../shared/runtime/model-source'
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  DEFAULT_WEIXIN_BASE_URL
} from '../channels/providers/weixin/weixin-login'
import type { FeishuService } from '../channels/providers/feishu/feishu-service'
import type { WeixinService } from '../channels/providers/weixin/weixin-service'

void BrowserWindow

let activeChannelManager: ChannelManager | null = null

interface ProjectRow {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id?: string | null
  pinned: number
  created_at: number
  updated_at: number
  workspace_id?: string | null
}

interface PluginSessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id?: string | null
  working_folder: string | null
  ssh_connection_id?: string | null
  plan_id?: string | null
  pinned: number
  message_count?: number
  plugin_id?: string | null
  external_chat_id?: string | null
  provider_id?: string | null
  model_id?: string | null
  model_selection_mode?: string | null
}

interface PluginSessionMessageRow {
  id: string
  role: string
  content: string
  created_at: number
}

interface PluginSessionMutationResult {
  success: boolean
  changed: number
  deleted: number
  error?: string | null
}

function requireBusinessRepository() {
  const writer = businessWriteCanary()
  if (!writer) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  return writer
}

function registerChannelMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    if (channel.startsWith('plugin:weixin:') || channel.startsWith('plugin:feishu:')) {
      const pluginArgs = args as { pluginId?: unknown; workspaceId?: unknown } | null
      await authorizeChannelPluginWorkspace(
        pluginArgs?.pluginId,
        pluginArgs?.workspaceId,
        readPlugins,
        loadOfflineWorkspaceIds
      )
    }
    return encodeMessagePackPayload(await handler(args))
  })
}

function assertPluginMutation(
  result: PluginSessionMutationResult,
  label: string
): PluginSessionMutationResult {
  if (!result.success) {
    throw new Error(result.error || `${label} failed`)
  }
  return result
}

async function normalizeQrDisplayUrl(url?: string): Promise<string | undefined> {
  const value = url?.trim()
  if (!value) return undefined
  if (value.startsWith('data:image/')) {
    if (
      value.length > 4 * 1024 * 1024 ||
      !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)
    ) {
      return undefined
    }
    return value
  }
  if (!/^https?:\/\//i.test(value)) return value

  try {
    const buffer = await downloadSafeRemoteResource(value)
    // QR providers return image bytes. Deliberately do not render arbitrary
    // remote HTML or follow image links: those paths turn a login preview into
    // an SSRF-capable browser surface.
    return `data:image/png;base64,${buffer.toString('base64')}`
  } catch {
    return undefined
  }
}

function resolveSourceFileName(source: string, fallback: string): string {
  const value = source.trim()
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const fileName = path.basename(url.pathname)
      return decodeURIComponent(fileName || fallback)
    } catch {
      return fallback
    }
  }

  const sanitized = value.split('?')[0]
  return path.basename(sanitized) || fallback
}

async function readBinarySource(
  source: string,
  fallbackName: string
): Promise<{ buffer: Buffer; fileName: string }> {
  const value = source.trim()
  if (!value) {
    throw new Error('File path is empty')
  }

  if (/^https?:\/\//i.test(value)) {
    return {
      buffer: await downloadSafeRemoteResource(value),
      fileName: resolveSourceFileName(value, fallbackName)
    }
  }

  if (!fs.existsSync(value)) {
    throw new Error(`File not found: ${value}`)
  }

  return {
    buffer: fs.readFileSync(value),
    fileName: resolveSourceFileName(value, fallbackName)
  }
}

// ── Persistence helpers ──

function buildToolsMap(
  descriptor?: ChannelProviderDescriptor,
  existing?: Record<string, boolean>
): Record<string, boolean> | undefined {
  if (!descriptor?.tools || descriptor.tools.length === 0) {
    return existing
  }
  const next: Record<string, boolean> = {}
  for (const toolName of descriptor.tools) {
    next[toolName] = existing?.[toolName] ?? true
  }
  return next
}

async function readPlugins(): Promise<ChannelInstance[]> {
  return await readChannelPlugins()
}

export async function isPluginToolEnabled(pluginId: string, toolName: string): Promise<boolean> {
  return await isChannelPluginToolEnabled(pluginId, toolName)
}

async function writePlugins(plugins: ChannelInstance[]): Promise<void> {
  await writeChannelPlugins(plugins)
}

/**
 * Channel configurations are public data. Keep the legacy provider/model
 * projection synchronized, but make ModelSource the authoritative binding so
 * managed resources cannot be mistaken for an ordinary local provider.
 */
function normalizeChannelModelBinding(channel: ChannelInstance): ChannelInstance {
  const workspaceId = channel.workspaceId?.trim() || 'local-personal'
  let source: ModelSource | null | undefined = channel.modelSource
  if (source !== undefined && source !== null) {
    source = parseModelSource(source)
    if (source.kind !== 'local' && source.workspaceId !== workspaceId)
      throw new Error('WORKSPACE_MISMATCH')
  } else if (channel.providerId && channel.model) {
    // Older managed bindings did not persist the workspace kind. Retain their
    // legacy projection for reading; only an explicit typed update may upgrade
    // them, because guessing personal vs team would weaken authorization.
    source = channel.providerId.startsWith('ola-managed:')
      ? undefined
      : legacyModelSource(channel.providerId, channel.model)
  } else {
    source = null
  }
  const selection = source
    ? modelSourceSelection(source)
    : source === undefined
      ? { providerId: channel.providerId ?? null, modelId: channel.model ?? null }
      : { providerId: null, modelId: null }
  return {
    ...channel,
    workspaceId,
    modelSource: source,
    providerId: selection.providerId,
    model: selection.modelId
  }
}

// ── Notify renderer of channel events ──

function notifyRenderer(event: ChannelEvent): void {
  if (event.type === 'incoming_message') {
    handleChannelAutoReply(event)
    return
  }
  safeSendMessagePackToAllWindows('plugin:incoming-message', event)
}

// ── Register IPC handlers ──

/**
 * Auto-start plugins that have features.autoStart = true and are enabled.
 * Called once at app startup after handlers are registered.
 */
export async function autoStartChannels(channelManager: ChannelManager): Promise<void> {
  const channels = await readPlugins()
  const toStart = channels.filter(
    (p) => p.enabled && (p.features?.autoStart ?? true) // default true for backward compat
  )
  for (const instance of toStart) {
    try {
      const current = await loadAuthorizedChannelPlugin(
        instance.id,
        instance.workspaceId,
        readPlugins,
        loadOfflineWorkspaceIds
      )
      if (!current.enabled || !(current.features?.autoStart ?? true)) continue
      await channelManager.startPlugin(current, notifyRenderer)
      console.log(`[Channel Manager] Auto-started: ${instance.name} (${instance.type})`)
    } catch (err) {
      console.error(`[Channel Manager] Auto-start failed for ${instance.name}:`, err)
    }
  }
}

let _handlersRegistered = false

export async function executePluginAction(args: {
  pluginId: string
  action: string
  params: Record<string, unknown>
  workspaceId?: string
}): Promise<unknown> {
  const { pluginId, action, params } = args
  await authorizeChannelPluginWorkspace(
    pluginId,
    args.workspaceId,
    readPlugins,
    loadOfflineWorkspaceIds
  )
  const service = activeChannelManager?.getService(pluginId)
  if (!service) {
    throw new Error(`Plugin ${pluginId} is not running`)
  }

  switch (action) {
    case 'sendMessage': {
      const target = service as typeof service & {
        sendWakeupMessage?: (chatId: string, content: string) => Promise<{ messageId: string }>
      }
      if (params.isWakeup === true && typeof target.sendWakeupMessage === 'function') {
        return await target.sendWakeupMessage(params.chatId as string, params.content as string)
      }
      return await service.sendMessage(params.chatId as string, params.content as string)
    }
    case 'replyMessage':
      return await service.replyMessage(params.messageId as string, params.content as string)
    case 'getGroupMessages':
      return await service.getGroupMessages(params.chatId as string, (params.count as number) ?? 20)
    case 'listGroups':
      return await service.listGroups()
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

export async function executeChannelSpecificPluginTool(
  channel: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const pluginId = typeof args.pluginId === 'string' ? args.pluginId : ''
  const toolName = typeof args.toolName === 'string' ? args.toolName : ''
  if (!pluginId) {
    return { error: 'Missing pluginId' }
  }
  await authorizeChannelPluginWorkspace(
    pluginId,
    args.workspaceId,
    readPlugins,
    loadOfflineWorkspaceIds
  )
  if (toolName && !(await isPluginToolEnabled(pluginId, toolName))) {
    return { error: `Tool "${toolName}" is disabled for this channel.` }
  }

  switch (channel) {
    case 'plugin:weixin:send-image': {
      const service = activeChannelManager?.getService(pluginId) as WeixinService | undefined
      if (!service) return { error: 'Weixin plugin not running or not found' }

      try {
        const { buffer } = await readBinarySource(String(args.filePath ?? ''), 'image.png')
        const result = await service.sendImage(
          String(args.chatId ?? ''),
          buffer,
          typeof args.content === 'string' ? args.content : undefined
        )
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Weixin] send-image failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:weixin:send-file': {
      const service = activeChannelManager?.getService(pluginId) as WeixinService | undefined
      if (!service) return { error: 'Weixin plugin not running or not found' }

      try {
        const { buffer, fileName } = await readBinarySource(String(args.filePath ?? ''), 'file')
        const result = await service.sendFile(
          String(args.chatId ?? ''),
          buffer,
          fileName,
          typeof args.content === 'string' ? args.content : undefined
        )
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Weixin] send-file failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-image': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = String(args.filePath ?? '').trim()
        console.log(`[Feishu] send-image: src=${src}, chatId=${args.chatId}`)
        if (/^https?:\/\//i.test(src)) {
          console.log(`[Feishu] Downloading image from URL...`)
          buf = await FeishuApi.downloadUrl(src)
        } else {
          if (!fs.existsSync(src)) {
            const msg = `File not found: ${src}`
            console.error(`[Feishu] send-image failed: ${msg}`)
            return { error: msg }
          }
          buf = fs.readFileSync(src)
        }
        console.log(`[Feishu] Uploading image (${buf.byteLength} bytes)...`)
        const fileName = path.basename(src.split('?')[0]) || 'image.png'
        const imageKey = await service.api.uploadImage(buf, fileName)
        console.log(`[Feishu] Uploaded image_key=${imageKey}, sending to chat...`)
        const result = await service.api.sendImageMessage(String(args.chatId ?? ''), imageKey)
        console.log(`[Feishu] Sent image to ${args.chatId}: messageId=${result.messageId}`)
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-image failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-file': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = String(args.filePath ?? '').trim()
        console.log(`[Feishu] send-file: src=${src}, chatId=${args.chatId}`)
        if (/^https?:\/\//i.test(src)) {
          console.log(`[Feishu] Downloading file from URL...`)
          buf = await FeishuApi.downloadUrl(src)
        } else {
          if (!fs.existsSync(src)) {
            const msg = `File not found: ${src}`
            console.error(`[Feishu] send-file failed: ${msg}`)
            return { error: msg }
          }
          buf = fs.readFileSync(src)
        }
        const fileName = path.basename(src.split('?')[0]) || 'file'
        const ext = path.extname(fileName).toLowerCase().replace('.', '')
        const typeMap: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
          opus: 'opus',
          mp4: 'mp4',
          pdf: 'pdf',
          doc: 'doc',
          docx: 'doc',
          xls: 'xls',
          xlsx: 'xls',
          ppt: 'ppt',
          pptx: 'ppt'
        }
        const rawFileType = typeof args.fileType === 'string' ? args.fileType : undefined
        const fileType =
          rawFileType === 'opus' ||
          rawFileType === 'mp4' ||
          rawFileType === 'pdf' ||
          rawFileType === 'doc' ||
          rawFileType === 'xls' ||
          rawFileType === 'ppt' ||
          rawFileType === 'stream'
            ? rawFileType
            : (typeMap[ext] ?? 'stream')

        console.log(
          `[Feishu] Uploading file "${fileName}" (${buf.byteLength} bytes, type=${fileType})...`
        )
        const fileKey = await service.api.uploadFile(buf, fileName, fileType)
        console.log(`[Feishu] Uploaded file_key=${fileKey}, sending to chat...`)
        const result = await service.api.sendFileMessage(String(args.chatId ?? ''), fileKey)
        console.log(
          `[Feishu] Sent file "${fileName}" to ${args.chatId}: messageId=${result.messageId}`
        )
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-file failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-mention': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        const chatId = typeof args.chatId === 'string' ? args.chatId.trim() : ''
        if (!chatId) return { error: 'Missing chatId' }
        const info = await service.api.getChatInfo(chatId)
        if (info?.chatType !== 'group') {
          return { error: 'FeishuAtMember is only available in group chats.' }
        }

        const userIds = Array.isArray(args.userIds)
          ? args.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : []
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        const elements: Array<Record<string, string>> = []
        if (args.atAll === true) {
          elements.push({ tag: 'at', user_id: 'all' })
        }
        for (const uid of userIds) {
          elements.push({ tag: 'at', user_id: uid })
        }
        if (text) {
          const textValue = elements.length > 0 ? ` ${text}` : text
          elements.push({ tag: 'text', text: textValue })
        }
        if (elements.length === 0) return { error: 'Message content is empty' }

        const postContent = {
          zh_cn: {
            content: [elements]
          }
        }

        const result = await service.api.sendMessage(chatId, JSON.stringify(postContent), 'post')
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-mention failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:list-members': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        const chatId = typeof args.chatId === 'string' ? args.chatId.trim() : ''
        if (!chatId) return { error: 'Missing chatId' }
        return await service.api.listChatMembers({
          chatId,
          pageToken: typeof args.pageToken === 'string' ? args.pageToken : undefined,
          pageSize: typeof args.pageSize === 'number' ? args.pageSize : undefined,
          memberIdType:
            args.memberIdType === 'user_id' || args.memberIdType === 'union_id'
              ? args.memberIdType
              : 'open_id'
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] list-members failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-urgent': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        const userIds = Array.isArray(args.userIds)
          ? args.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : []
        const types = Array.isArray(args.urgentTypes)
          ? args.urgentTypes.filter((t): t is 'app' | 'sms' => t === 'app' || t === 'sms')
          : []
        const messageId = typeof args.messageId === 'string' ? args.messageId : ''
        if (!messageId || userIds.length === 0 || types.length === 0) {
          return { error: 'Missing messageId, userIds, or urgentTypes' }
        }
        for (const t of types) {
          await service.api.sendUrgent(messageId, userIds, t, 'user_id')
        }
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-urgent failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:bitable:list-apps':
    case 'plugin:feishu:bitable:list-tables':
    case 'plugin:feishu:bitable:list-fields':
    case 'plugin:feishu:bitable:get-records':
    case 'plugin:feishu:bitable:create-records':
    case 'plugin:feishu:bitable:update-records':
    case 'plugin:feishu:bitable:delete-records': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        switch (channel) {
          case 'plugin:feishu:bitable:list-apps':
            return { ok: true, data: await service.api.listBitableApps() }
          case 'plugin:feishu:bitable:list-tables':
            return {
              ok: true,
              data: await service.api.listBitableTables(String(args.appToken ?? ''))
            }
          case 'plugin:feishu:bitable:list-fields':
            return {
              ok: true,
              data: await service.api.listBitableFields(
                String(args.appToken ?? ''),
                String(args.tableId ?? '')
              )
            }
          case 'plugin:feishu:bitable:get-records':
            return {
              ok: true,
              data: await service.api.getBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                {
                  filter: typeof args.filter === 'string' ? args.filter : undefined,
                  pageSize: typeof args.pageSize === 'number' ? args.pageSize : undefined,
                  pageToken: typeof args.pageToken === 'string' ? args.pageToken : undefined
                }
              )
            }
          case 'plugin:feishu:bitable:create-records':
            return {
              ok: true,
              data: await service.api.createBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                Array.isArray(args.records) ? args.records : []
              )
            }
          case 'plugin:feishu:bitable:update-records':
            return {
              ok: true,
              data: await service.api.updateBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                Array.isArray(args.records) ? args.records : []
              )
            }
          case 'plugin:feishu:bitable:delete-records':
            return {
              ok: true,
              data: await service.api.deleteBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                Array.isArray(args.recordIds)
                  ? args.recordIds.filter(
                      (id): id is string => typeof id === 'string' && id.length > 0
                    )
                  : []
              )
            }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  }

  throw new Error(`Unsupported channel-specific plugin tool channel: ${channel}`)
}

export function registerChannelHandlers(channelManager: ChannelManager): void {
  activeChannelManager = channelManager
  if (_handlersRegistered) return
  _handlersRegistered = true

  // List available provider descriptors
  registerChannelMessagePackHandler<undefined>('plugin:list-providers', async () => {
    return CHANNEL_PROVIDERS
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    baseUrl?: string
    routeTag?: string
    accountId?: string
    force?: boolean
  }>('plugin:weixin:login-start', async (args) => {
    try {
      const result = await startWeixinLoginWithQr({
        accountId: args.accountId,
        apiBaseUrl: args.baseUrl || DEFAULT_WEIXIN_BASE_URL,
        routeTag: args.routeTag,
        force: args.force
      })
      return {
        qrDataUrl: await normalizeQrDisplayUrl(result.qrcodeUrl),
        qrUrl: result.qrcodeUrl,
        message: result.message,
        sessionKey: result.sessionKey
      }
    } catch (err) {
      return {
        message: err instanceof Error ? err.message : String(err),
        sessionKey: args.accountId || ''
      }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    baseUrl?: string
    routeTag?: string
    sessionKey: string
    timeoutMs?: number
  }>('plugin:weixin:login-wait', async (args) => {
    try {
      return await waitForWeixinLogin({
        sessionKey: args.sessionKey,
        apiBaseUrl: args.baseUrl || DEFAULT_WEIXIN_BASE_URL,
        routeTag: args.routeTag,
        timeoutMs: args.timeoutMs
      })
    } catch (err) {
      return {
        connected: false,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // List persisted plugin instances (auto-provisions built-in plugins)
  registerChannelMessagePackHandler<{ workspaceId: string }>('plugin:list', async (args) => {
    if (typeof args?.workspaceId !== 'string') throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
    const workspaceId = await authorizeChannelSessionWorkspace(
      args.workspaceId,
      loadOfflineWorkspaceIds
    )
    const plugins = await readPlugins()
    const belongsToWorkspace = (plugin: ChannelInstance): boolean =>
      channelPluginInWorkspace(plugin, workspaceId)
    const writer = requireBusinessRepository()
    const projects = (await writer.normalPluginProjects<ProjectRow>(workspaceId)).filter(
      (project) => (project.workspace_id || 'local-personal') === workspaceId
    )
    let changed = false

    // Migrate legacy unbound built-ins to the first normal project when there is only one.
    if (projects.length === 1) {
      for (const descriptor of CHANNEL_PROVIDERS) {
        const legacyUnbound = plugins.find(
          (p) => belongsToWorkspace(p) && p.type === descriptor.type && !p.projectId
        )
        const hasBoundInstance = plugins.some(
          (p) => p.type === descriptor.type && p.projectId === projects[0].id
        )
        if (legacyUnbound && !hasBoundInstance) {
          legacyUnbound.projectId = projects[0].id
          legacyUnbound.workspaceId = projects[0].workspace_id || 'local-personal'
          changed = true
        }
      }
    }

    const workspaceByProjectId = new Map(
      projects.map((project) => [project.id, project.workspace_id || 'local-personal'])
    )

    // Auto-provision one built-in channel instance per normal project and provider type.
    for (const project of projects) {
      for (const descriptor of CHANNEL_PROVIDERS) {
        const existing = plugins.find(
          (p) => p.type === descriptor.type && p.projectId === project.id
        )
        if (!existing) {
          const config: Record<string, string> = {}
          for (const field of descriptor.configSchema) {
            config[field.key] =
              descriptor.type === 'weixin-official' && field.key === 'baseUrl'
                ? DEFAULT_WEIXIN_BASE_URL
                : ''
          }
          plugins.push({
            id: nanoid(),
            type: descriptor.type,
            name: descriptor.displayName,
            enabled: false,
            builtin: true,
            config,
            createdAt: Date.now(),
            projectId: project.id,
            workspaceId: project.workspace_id || 'local-personal',
            tools: buildToolsMap(descriptor)
          })
          changed = true
        } else {
          if (!existing.builtin) {
            existing.builtin = true
            changed = true
          }
          if (existing.name !== descriptor.displayName) {
            existing.name = descriptor.displayName
            changed = true
          }
        }
      }
    }

    // Ensure old plugin instances have config keys matching their current schema
    for (const p of plugins.filter(belongsToWorkspace)) {
      const desc = CHANNEL_PROVIDERS.find((d) => d.type === p.type)
      if (!desc) continue
      const projectWorkspace = p.projectId ? workspaceByProjectId.get(p.projectId) : undefined
      if (projectWorkspace && p.workspaceId !== projectWorkspace) {
        p.workspaceId = projectWorkspace
        changed = true
      }
      const schemaKeys = new Set(desc.configSchema.map((f) => f.key))
      for (const field of desc.configSchema) {
        if (!(field.key in p.config)) {
          p.config[field.key] =
            desc.type === 'weixin-official' && field.key === 'baseUrl'
              ? DEFAULT_WEIXIN_BASE_URL
              : ''
          changed = true
        }
      }
      if (desc.type === 'weixin-official' && !p.config.baseUrl) {
        p.config.baseUrl = DEFAULT_WEIXIN_BASE_URL
        changed = true
      }
      // Remove config keys that are no longer in the schema
      for (const key of Object.keys(p.config)) {
        if (!schemaKeys.has(key)) {
          delete p.config[key]
          changed = true
        }
      }
      // Remove legacy top-level fields that are no longer supported
      for (const key of Object.keys(p)) {
        if (
          ![
            'id',
            'type',
            'name',
            'enabled',
            'builtin',
            'config',
            'createdAt',
            'projectId',
            'workspaceId',
            'tools',
            'providerId',
            'model',
            'modelSource',
            'features',
            'permissions'
          ].includes(key)
        ) {
          delete (p as unknown as Record<string, unknown>)[key]
          changed = true
        }
      }
      // Ensure tools map matches descriptor
      const nextTools = buildToolsMap(desc, p.tools)
      if (nextTools && JSON.stringify(nextTools) !== JSON.stringify(p.tools)) {
        p.tools = nextTools
        changed = true
      }
      const normalized = normalizeChannelModelBinding(p)
      if (JSON.stringify(normalized) !== JSON.stringify(p)) {
        Object.assign(p, normalized)
        changed = true
      }
    }

    if (changed) await writePlugins(plugins)
    const scoped = plugins.filter(belongsToWorkspace)
    console.log(
      `[Channels] Loaded ${scoped.length} channels (${scoped.filter((p) => p.builtin).length} built-in)`
    )
    return scoped
  })

  // Add a new plugin instance
  registerChannelMessagePackHandler<ChannelInstance>('plugin:add', async (instance) => {
    if (typeof instance?.workspaceId !== 'string') throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
    const workspaceId = await authorizeChannelSessionWorkspace(
      instance.workspaceId,
      loadOfflineWorkspaceIds
    )
    const plugins = await readPlugins()
    if (!instance.id || plugins.some((plugin) => plugin.id === instance.id))
      throw new Error('CHANNEL_PLUGIN_ID_UNAVAILABLE')
    if (instance.projectId) {
      const writer = requireBusinessRepository()
      const projects = await writer.normalPluginProjects<ProjectRow>(workspaceId)
      const project = projects.find((item) => item.id === instance.projectId)
      if (!project || (project.workspace_id || 'local-personal') !== workspaceId)
        throw new Error('CHANNEL_PROJECT_WORKSPACE_MISMATCH')
    }
    const desc = CHANNEL_PROVIDERS.find((d) => d.type === instance.type)
    const nextTools = buildToolsMap(desc, instance.tools)
    plugins.push(
      normalizeChannelModelBinding({
        ...instance,
        workspaceId,
        ...(nextTools ? { tools: nextTools } : {})
      })
    )
    await writePlugins(plugins)
    return { success: true }
  })

  // Update a plugin instance
  registerChannelMessagePackHandler<{
    id: string
    workspaceId: string
    patch: Partial<ChannelInstance>
  }>('plugin:update', async ({ id, workspaceId, patch }) => {
    await authorizeChannelPluginWorkspace(id, workspaceId, readPlugins, loadOfflineWorkspaceIds)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('INVALID_CHANNEL_PATCH')
    const plugins = await readPlugins()
    const writer = requireBusinessRepository()
    const idx = plugins.findIndex((p) => p.id === id)
    if (idx === -1) return { success: false, error: 'Plugin not found' }
    if (
      ('workspaceId' in patch && patch.workspaceId !== workspaceId) ||
      ('id' in patch && patch.id !== id)
    )
      throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
    let next = { ...plugins[idx], ...patch }
    if ('projectId' in patch && patch.projectId) {
      const projects = await writer.normalPluginProjects<ProjectRow>(workspaceId)
      const project = projects.find((item) => item.id === patch.projectId)
      if (!project) return { success: false, error: 'Project not found' }
      if ((project.workspace_id || 'local-personal') !== workspaceId)
        throw new Error('CHANNEL_PROJECT_WORKSPACE_MISMATCH')
    }
    if ('providerId' in patch && patch.providerId == null) {
      next.model = null
    }
    if (('providerId' in patch || 'model' in patch) && !('modelSource' in patch)) {
      // A legacy selector edit intentionally replaces a previous explicit
      // binding. The normalizer upgrades local selections and preserves an
      // old managed projection only when its workspace kind is unknown.
      next.modelSource = undefined
    }
    next = normalizeChannelModelBinding(next)
    plugins[idx] = next
    await writePlugins(plugins)

    if ('providerId' in patch || 'model' in patch || 'modelSource' in patch) {
      try {
        const providerId = next.providerId ?? null
        const modelId = providerId ? (next.model ?? null) : null
        const result = await writer.syncPluginSessionModels({
          pluginId: id,
          providerId,
          modelId,
          workspaceId,
          modelSource: next.modelSource ? JSON.stringify(next.modelSource) : null
        })
        assertPluginMutation(result, 'Sync channel session model')
      } catch (err) {
        console.error('[Channels] Failed to sync channel session model:', err)
      }
    }

    if ('projectId' in patch) {
      try {
        const result = await writer.syncPluginSessionProject({
          pluginId: id,
          projectId: next.projectId ?? null,
          workspaceId
        })
        assertPluginMutation(result, 'Sync channel project binding')
      } catch (err) {
        console.error('[Channels] Failed to sync channel project binding:', err)
      }
    }
    return { success: true }
  })

  // Remove a plugin instance (also cascade-deletes plugin sessions)
  // Built-in plugins cannot be removed.
  registerChannelMessagePackHandler<{ pluginId: string; workspaceId: string }>(
    'plugin:remove',
    async ({ pluginId: id, workspaceId }) => {
      await authorizeChannelPluginWorkspace(id, workspaceId, readPlugins, loadOfflineWorkspaceIds)
      const allPlugins = await readPlugins()
      const writer = requireBusinessRepository()
      const target = allPlugins.find((p) => p.id === id)
      if (!target) return { success: false, error: 'Plugin not found' }
      if (target?.builtin) {
        return { success: false, error: 'Built-in plugins cannot be removed' }
      }
      // Stop service if running
      await channelManager.stopPlugin(id)
      const plugins = allPlugins.filter((p) => p.id !== id)
      await writePlugins(plugins)
      // Cascade-delete plugin sessions and their messages
      try {
        const workspace = target?.workspaceId || 'local-personal'
        const result = await writer.removePluginData({ pluginId: id, workspaceId: workspace })
        assertPluginMutation(result, 'Remove channel data')
      } catch (err) {
        console.error('[Channels] Failed to cascade-delete sessions:', err)
      }
      return { success: true }
    }
  )

  // Start a plugin service
  registerChannelMessagePackHandler<{ pluginId: string; workspaceId: string }>(
    'plugin:start',
    async ({ pluginId, workspaceId }) => {
      try {
        const instance = await loadAuthorizedChannelPlugin(
          pluginId,
          workspaceId,
          readPlugins,
          loadOfflineWorkspaceIds
        )
        await channelManager.startPlugin(instance, notifyRenderer)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // Stop a plugin service
  registerChannelMessagePackHandler<{ pluginId: string; workspaceId: string }>(
    'plugin:stop',
    async ({ pluginId, workspaceId }) => {
      await authorizeChannelPluginWorkspace(
        pluginId,
        workspaceId,
        readPlugins,
        loadOfflineWorkspaceIds
      )
      await channelManager.stopPlugin(pluginId)
      return { success: true }
    }
  )

  // Get plugin status
  registerChannelMessagePackHandler<{ pluginId: string; workspaceId: string }>(
    'plugin:status',
    async ({ pluginId, workspaceId }) => {
      await authorizeChannelPluginWorkspace(
        pluginId,
        workspaceId,
        readPlugins,
        loadOfflineWorkspaceIds
      )
      return channelManager.getStatus(pluginId)
    }
  )

  // Unified action dispatch — routes to the correct MessagingPluginService method
  registerChannelMessagePackHandler<{
    pluginId: string
    action: string
    params: Record<string, unknown>
    workspaceId: string
  }>('plugin:exec', async ({ pluginId, action, params, workspaceId }) => {
    if (typeof workspaceId !== 'string') throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
    return await executePluginAction({ pluginId, action, params, workspaceId })
  })

  // List plugin sessions (filtered by plugin_id)
  registerChannelMessagePackHandler<{ pluginId: string; workspaceId?: string }>(
    'plugin:sessions:list',
    async ({ pluginId, workspaceId: rawWorkspaceId }) => {
      const workspaceId = await authorizeChannelSessionWorkspace(
        rawWorkspaceId,
        loadOfflineWorkspaceIds
      )
      const plugin = (await readPlugins()).find((item) => item.id === pluginId)
      if (!plugin || (plugin.workspaceId || 'local-personal') !== workspaceId)
        throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
      return await readAuthorizedChannelSession(workspaceId, loadOfflineWorkspaceIds, async () =>
        requireBusinessRepository().pluginSessions<PluginSessionRow>(pluginId, workspaceId)
      )
    }
  )

  // Create a plugin session
  registerChannelMessagePackHandler<{
    id: string
    pluginId: string
    title: string
    mode: string
    createdAt: number
    updatedAt: number
    externalChatId?: string
    workspaceId?: string
  }>('plugin:sessions:create', async (args) => {
    const workspaceId = await authorizeChannelSessionWorkspace(
      args.workspaceId,
      loadOfflineWorkspaceIds
    )
    const plugin = (await readPlugins()).find((item) => item.id === args.pluginId)
    if (!plugin || (plugin.workspaceId || 'local-personal') !== workspaceId)
      throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
    await requireBusinessRepository().createChannelSession({
      id: args.id,
      pluginId: args.pluginId,
      title: args.title,
      mode: args.mode,
      workspaceId,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
      externalChatId: args.externalChatId ?? null,
      projectId: plugin.projectId ?? null,
      providerId: plugin.providerId ?? null,
      modelId: plugin.model ?? null
    })
    return { success: true }
  })

  // Find a plugin session by external chat ID
  registerChannelMessagePackHandler<{ externalChatId: string; workspaceId?: string }>(
    'plugin:sessions:find-by-chat',
    async ({ externalChatId, workspaceId: rawWorkspaceId }) => {
      const workspaceId = await authorizeChannelSessionWorkspace(
        rawWorkspaceId,
        loadOfflineWorkspaceIds
      )
      return await readAuthorizedChannelSession(workspaceId, loadOfflineWorkspaceIds, () =>
        requireBusinessRepository().pluginSessionByChat<PluginSessionRow>(
          externalChatId,
          workspaceId
        )
      )
    }
  )

  // ── Streaming output IPC ──

  // Active streaming handles keyed by per-reply streamId.
  const streamHandles = new Map<
    string,
    {
      handle: import('../channels/channel-types').ChannelStreamingHandle
      workspaceId: string
      pluginId: string
      chatId: string
      service: MessagingChannelService
    }
  >()
  const streamContents = new Map<string, string>()
  const streamStartsInFlight = new Set<string>()

  async function activeStream(args: {
    pluginId: string
    workspaceId: string
    chatId: string
    streamId?: string
  }): Promise<{ key: string; stream: NonNullable<ReturnType<typeof streamHandles.get>> } | null> {
    const key = args.streamId || `${args.pluginId}:${args.chatId}`
    const stream = streamHandles.get(key)
    try {
      await authorizeChannelStreamWorkspace(
        args.pluginId,
        args.workspaceId,
        stream?.workspaceId,
        readPlugins,
        loadOfflineWorkspaceIds
      )
    } catch (error) {
      if (
        stream &&
        stream.pluginId === args.pluginId &&
        stream.chatId === args.chatId &&
        stream.workspaceId === args.workspaceId
      ) {
        streamHandles.delete(key)
        streamContents.delete(key)
      }
      throw error
    }
    if (!stream || stream.pluginId !== args.pluginId || stream.chatId !== args.chatId) return null
    if (channelManager.getService(args.pluginId) !== stream.service) {
      streamHandles.delete(key)
      streamContents.delete(key)
      return null
    }
    return { key, stream }
  }

  /**
   * Start a streaming message for a plugin chat.
   * Returns { ok: true, supportsStreaming: true } if streaming was initiated,
   * or { ok: false } if the plugin doesn't support streaming (caller should fallback).
   */
  registerChannelMessagePackHandler<{
    pluginId: string
    workspaceId: string
    chatId: string
    streamId?: string
    initialContent: string
    messageId?: string
  }>('plugin:stream:start', async (args) => {
    const workspaceId = await authorizeChannelStreamWorkspace(
      args.pluginId,
      args.workspaceId,
      undefined,
      readPlugins,
      loadOfflineWorkspaceIds
    )
    const service = channelManager.getService(args.pluginId)
    if (!service || !service.supportsStreaming || !service.sendStreamingMessage) {
      return { ok: false, supportsStreaming: false }
    }
    const key = args.streamId || `${args.pluginId}:${args.chatId}`
    const existing = streamHandles.get(key)
    if (existing && existing.service !== service) {
      streamHandles.delete(key)
      streamContents.delete(key)
    }
    if (streamHandles.has(key) || streamStartsInFlight.has(key))
      return { ok: false, error: 'CHANNEL_STREAM_ALREADY_EXISTS' }
    streamStartsInFlight.add(key)

    try {
      const handle = await service.sendStreamingMessage(
        args.chatId,
        args.initialContent,
        args.messageId
      )
      await authorizeChannelStreamWorkspace(
        args.pluginId,
        args.workspaceId,
        workspaceId,
        readPlugins,
        loadOfflineWorkspaceIds
      )
      if (channelManager.getService(args.pluginId) !== service)
        return { ok: false, error: 'CHANNEL_STREAM_SERVICE_CHANGED' }
      streamHandles.set(key, {
        handle,
        workspaceId,
        pluginId: args.pluginId,
        chatId: args.chatId,
        service
      })
      streamContents.set(key, args.initialContent ?? '')
      console.log(`[PluginStream] Started streaming for ${args.pluginId}:${args.chatId}:${key}`)
      return { ok: true, supportsStreaming: true }
    } catch (err) {
      console.error('[PluginStream] Failed to start streaming:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      streamStartsInFlight.delete(key)
    }
  })

  // ── Plugin Session Management ──

  /** List all plugin sessions (sessions with plugin_id set) */
  registerChannelMessagePackHandler<{ workspaceId?: string }>(
    'plugin:sessions:list-all',
    async (args) => {
      const workspaceId = await authorizeChannelSessionWorkspace(
        args?.workspaceId,
        loadOfflineWorkspaceIds
      )
      return await readAuthorizedChannelSession(workspaceId, loadOfflineWorkspaceIds, () =>
        requireBusinessRepository().allPluginSessions<PluginSessionRow>(workspaceId)
      )
    }
  )

  /** Get messages for a plugin session */
  registerChannelMessagePackHandler<{
    sessionId: string
    limit?: number
    offset?: number
    workspaceId?: string
  }>('plugin:sessions:messages', async (args) => {
    const workspaceId = await authorizeChannelSessionWorkspace(
      args.workspaceId,
      loadOfflineWorkspaceIds
    )
    return await readAuthorizedChannelSession(workspaceId, loadOfflineWorkspaceIds, () =>
      requireBusinessRepository().pluginSessionMessages<PluginSessionMessageRow>(
        args.sessionId,
        workspaceId,
        args.limit,
        args.offset
      )
    )
  })

  /** Clear all messages in a plugin session */
  registerChannelMessagePackHandler<{ sessionId: string; workspaceId?: string }>(
    'plugin:sessions:clear',
    async (args) => {
      const workspaceId = await authorizeChannelSessionWorkspace(
        args.workspaceId,
        loadOfflineWorkspaceIds
      )
      const deleted = await requireBusinessRepository().clearChannelSession({
        sessionId: args.sessionId,
        workspaceId
      })
      return { deleted }
    }
  )

  /** Delete a plugin session and its messages */
  registerChannelMessagePackHandler<{ sessionId: string; workspaceId?: string }>(
    'plugin:sessions:delete',
    async (args) => {
      const workspaceId = await authorizeChannelSessionWorkspace(
        args.workspaceId,
        loadOfflineWorkspaceIds
      )
      const changed = await requireBusinessRepository().deleteChannelSession({
        sessionId: args.sessionId,
        workspaceId
      })
      if (!changed) throw new Error('CHANNEL_SESSION_NOT_FOUND')
      const payload = { sessionId: args.sessionId }
      safeSendMessagePackToAllWindows('plugin:session-deleted', payload)
      return { ok: true }
    }
  )

  /** Rename a plugin session */
  registerChannelMessagePackHandler<{ sessionId: string; title: string; workspaceId?: string }>(
    'plugin:sessions:rename',
    async (args) => {
      const workspaceId = await authorizeChannelSessionWorkspace(
        args.workspaceId,
        loadOfflineWorkspaceIds
      )
      const changed = await requireBusinessRepository().renameChannelSession({
        sessionId: args.sessionId,
        workspaceId,
        title: args.title
      })
      if (!changed) throw new Error('CHANNEL_SESSION_NOT_FOUND')
      return { ok: true }
    }
  )

  // ── Weixin media send ──

  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    filePath: string
    content?: string
  }>('plugin:weixin:send-image', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/weixin/weixin-service').WeixinService
      | undefined
    if (!service) return { error: 'Weixin plugin not running or not found' }

    try {
      const { buffer } = await readBinarySource(args.filePath, 'image.png')
      const result = await service.sendImage(args.chatId, buffer, args.content)
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Weixin] send-image failed:', msg)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    filePath: string
    content?: string
  }>('plugin:weixin:send-file', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/weixin/weixin-service').WeixinService
      | undefined
    if (!service) return { error: 'Weixin plugin not running or not found' }

    try {
      const { buffer, fileName } = await readBinarySource(args.filePath, 'file')
      const result = await service.sendFile(args.chatId, buffer, fileName, args.content)
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Weixin] send-file failed:', msg)
      return { error: msg }
    }
  })

  // ── Feishu media send ──

  /**
   * Send an image to a Feishu chat.
   * `source` can be:
   *   - An absolute local file path  (e.g. /home/user/pic.png or C:\...\pic.png)
   *   - An HTTP/HTTPS URL            (e.g. https://example.com/image.png)
   */
  registerChannelMessagePackHandler<{ pluginId: string; chatId: string; filePath: string }>(
    'plugin:feishu:send-image',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = args.filePath.trim()
        console.log(`[Feishu] send-image: src=${src}, chatId=${args.chatId}`)
        if (/^https?:\/\//i.test(src)) {
          console.log(`[Feishu] Downloading image from URL...`)
          buf = await FeishuApi.downloadUrl(src)
        } else {
          if (!fs.existsSync(src)) {
            const msg = `File not found: ${src}`
            console.error(`[Feishu] send-image failed: ${msg}`)
            return { error: msg }
          }
          buf = fs.readFileSync(src)
        }
        console.log(`[Feishu] Uploading image (${buf.byteLength} bytes)...`)
        const fileName = path.basename(src.split('?')[0]) || 'image.png'
        const imageKey = await service.api.uploadImage(buf, fileName)
        console.log(`[Feishu] Uploaded image_key=${imageKey}, sending to chat...`)
        const result = await service.api.sendImageMessage(args.chatId, imageKey)
        console.log(`[Feishu] Sent image to ${args.chatId}: messageId=${result.messageId}`)
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-image failed:', msg)
        return { error: msg }
      }
    }
  )

  /**
   * Send a file to a Feishu chat.
   * `source` can be:
   *   - An absolute local file path  (e.g. /home/user/doc.pdf)
   *   - An HTTP/HTTPS URL            (e.g. https://example.com/report.pdf)
   * `fileType` is auto-detected from extension if not provided.
   */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    filePath: string
    fileType?: string
  }>('plugin:feishu:send-file', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      let buf: Buffer
      const src = args.filePath.trim()
      console.log(`[Feishu] send-file: src=${src}, chatId=${args.chatId}`)
      if (/^https?:\/\//i.test(src)) {
        console.log(`[Feishu] Downloading file from URL...`)
        buf = await FeishuApi.downloadUrl(src)
      } else {
        if (!fs.existsSync(src)) {
          const msg = `File not found: ${src}`
          console.error(`[Feishu] send-file failed: ${msg}`)
          return { error: msg }
        }
        buf = fs.readFileSync(src)
      }
      const fileName = path.basename(src.split('?')[0]) || 'file'

      // Auto-detect file type from extension
      const ext = path.extname(fileName).toLowerCase().replace('.', '')
      const typeMap: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
        opus: 'opus',
        mp4: 'mp4',
        pdf: 'pdf',
        doc: 'doc',
        docx: 'doc',
        xls: 'xls',
        xlsx: 'xls',
        ppt: 'ppt',
        pptx: 'ppt'
      }
      const fileType =
        (args.fileType as 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' | undefined) ??
        typeMap[ext] ??
        'stream'

      console.log(
        `[Feishu] Uploading file "${fileName}" (${buf.byteLength} bytes, type=${fileType})...`
      )
      const fileKey = await service.api.uploadFile(buf, fileName, fileType)
      console.log(`[Feishu] Uploaded file_key=${fileKey}, sending to chat...`)
      const result = await service.api.sendFileMessage(args.chatId, fileKey)
      console.log(
        `[Feishu] Sent file "${fileName}" to ${args.chatId}: messageId=${result.messageId}`
      )
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] send-file failed:', msg)
      return { error: msg }
    }
  })

  /** Mention members in a Feishu group chat */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId?: string
    userIds?: string[]
    atAll?: boolean
    text?: string
  }>('plugin:feishu:send-mention', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const chatId = args.chatId?.trim()
      if (!chatId) return { error: 'Missing chatId' }
      const info = await service.api.getChatInfo(chatId)
      if (info?.chatType !== 'group') {
        return { error: 'FeishuAtMember is only available in group chats.' }
      }

      const userIds = Array.isArray(args.userIds) ? args.userIds.filter(Boolean) : []
      const text = args.text?.trim() ?? ''
      const elements: Array<Record<string, string>> = []
      if (args.atAll) {
        elements.push({ tag: 'at', user_id: 'all' })
      }
      for (const uid of userIds) {
        elements.push({ tag: 'at', user_id: uid })
      }
      if (text) {
        const textValue = elements.length > 0 ? ` ${text}` : text
        elements.push({ tag: 'text', text: textValue })
      }
      if (elements.length === 0) return { error: 'Message content is empty' }

      const postContent = {
        zh_cn: {
          content: [elements]
        }
      }

      const result = await service.api.sendMessage(chatId, JSON.stringify(postContent), 'post')
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] send-mention failed:', msg)
      return { error: msg }
    }
  })

  /** List members in a Feishu chat */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId?: string
    pageToken?: string
    pageSize?: number
    memberIdType?: 'open_id' | 'user_id' | 'union_id'
  }>('plugin:feishu:list-members', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const chatId = args.chatId?.trim()
      if (!chatId) return { error: 'Missing chatId' }
      const result = await service.api.listChatMembers({
        chatId,
        pageToken: args.pageToken,
        pageSize: args.pageSize,
        memberIdType: args.memberIdType
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] list-members failed:', msg)
      return { error: msg }
    }
  })

  /** Send urgent push (app/sms) */
  registerChannelMessagePackHandler<{
    pluginId: string
    messageId: string
    userIds: string[]
    urgentTypes: Array<'app' | 'sms'>
  }>('plugin:feishu:send-urgent', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const types = Array.isArray(args.urgentTypes)
        ? args.urgentTypes.filter((t) => t === 'app' || t === 'sms')
        : []
      if (!args.messageId || !args.userIds?.length || types.length === 0) {
        return { error: 'Missing messageId, userIds, or urgentTypes' }
      }
      for (const t of types) {
        await service.api.sendUrgent(args.messageId, args.userIds, t, 'user_id')
      }
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] send-urgent failed:', msg)
      return { error: msg }
    }
  })

  /** Download Feishu message resource (audio/file) as base64 */
  registerChannelMessagePackHandler<{
    pluginId: string
    messageId: string
    fileKey: string
    type?: 'image' | 'file'
    mediaType?: string
  }>('plugin:feishu:download-resource', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const buf = await service.api.downloadMessageResource(
        args.messageId,
        args.fileKey,
        args.type ?? 'file'
      )
      return {
        ok: true,
        base64: buf.toString('base64'),
        mediaType: args.mediaType ?? 'application/octet-stream'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] download-resource failed:', msg)
      return { error: msg }
    }
  })

  // ── Feishu Bitable ──

  registerChannelMessagePackHandler<{ pluginId: string }>(
    'plugin:feishu:bitable:list-apps',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        const data = await service.api.listBitableApps()
        return { ok: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  registerChannelMessagePackHandler<{ pluginId: string; appToken: string }>(
    'plugin:feishu:bitable:list-tables',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        const data = await service.api.listBitableTables(args.appToken)
        return { ok: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  registerChannelMessagePackHandler<{ pluginId: string; appToken: string; tableId: string }>(
    'plugin:feishu:bitable:list-fields',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        const data = await service.api.listBitableFields(args.appToken, args.tableId)
        return { ok: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    filter?: string
    pageSize?: number
    pageToken?: string
  }>('plugin:feishu:bitable:get-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.getBitableRecords(args.appToken, args.tableId, {
        filter: args.filter,
        pageSize: args.pageSize,
        pageToken: args.pageToken
      })
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    records: unknown[]
  }>('plugin:feishu:bitable:create-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.createBitableRecords(args.appToken, args.tableId, args.records)
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    records: unknown[]
  }>('plugin:feishu:bitable:update-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.updateBitableRecords(args.appToken, args.tableId, args.records)
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    recordIds: string[]
  }>('plugin:feishu:bitable:delete-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.deleteBitableRecords(
        args.appToken,
        args.tableId,
        args.recordIds
      )
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  // ── Streaming ──

  /** Send a streaming content update (accumulated text, not delta) */
  registerChannelMessagePackHandler<{
    pluginId: string
    workspaceId: string
    chatId: string
    streamId?: string
    content: string
  }>('plugin:stream:update', async (args) => {
    const active = await activeStream(args)
    if (!active) return { ok: false }
    const { key, stream } = active

    try {
      streamContents.set(key, args.content)
      await stream.handle.update(args.content)
      return { ok: true }
    } catch (err) {
      console.warn(`[PluginStream] Update failed for ${key}:`, err)
      return { ok: false }
    }
  })

  /** Append a streaming delta and forward the accumulated content to providers */
  registerChannelMessagePackHandler<{
    pluginId: string
    workspaceId: string
    chatId: string
    streamId?: string
    delta: string
  }>('plugin:stream:append', async (args) => {
    const active = await activeStream(args)
    if (!active) return { ok: false }
    const { key, stream } = active

    try {
      const nextContent = `${streamContents.get(key) ?? ''}${args.delta ?? ''}`
      streamContents.set(key, nextContent)
      await stream.handle.update(nextContent)
      return { ok: true }
    } catch (err) {
      console.warn(`[PluginStream] Append failed for ${key}:`, err)
      return { ok: false }
    }
  })

  /** Finish the streaming message with final content */
  registerChannelMessagePackHandler<{
    pluginId: string
    workspaceId: string
    chatId: string
    streamId?: string
    content: string
  }>('plugin:stream:finish', async (args) => {
    const active = await activeStream(args)
    if (!active) return { ok: false }
    const { key, stream } = active

    try {
      streamContents.set(key, args.content)
      await stream.handle.finish(args.content)
      streamHandles.delete(key)
      streamContents.delete(key)
      console.log(`[PluginStream] Finished streaming for ${args.pluginId}:${args.chatId}:${key}`)
      return { ok: true }
    } catch (err) {
      console.error(`[PluginStream] Finish failed for ${args.pluginId}:${args.chatId}:${key}:`, err)
      streamHandles.delete(key)
      streamContents.delete(key)
      return { ok: false }
    }
  })
}
