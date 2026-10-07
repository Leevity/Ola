import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { trackCronDelivery } from '../cron/cron-delivery-tracking'

const MAX_MESSAGES = 100

type ChannelReadInput = {
  pluginId: string
  chatId?: string
  count: number
}

type ChannelWriteInput = { pluginId: string; chatId: string; content: string; messageId?: string }

function readInput(value: unknown, chatRequired: boolean): ChannelReadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
  const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
  const count = item.count === undefined ? 20 : item.count
  if (
    !pluginId ||
    pluginId.length > 256 ||
    (chatRequired && !chatId) ||
    chatId.length > 512 ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_MESSAGES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { pluginId, ...(chatId ? { chatId } : {}), count }
}

async function executeReadAction(
  action: 'getGroupMessages' | 'listGroups',
  input: ChannelReadInput,
  workspaceId: string
): Promise<unknown> {
  // Keep the channel manager behind a dynamic Main import so the shared TS
  // runtime remains Electron-free and the channel providers stay lazy-loaded.
  const { executePluginAction } = await import('../ipc/channel-handlers')
  return executePluginAction({
    pluginId: input.pluginId,
    workspaceId,
    action,
    params: {
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(action === 'getGroupMessages' ? { count: input.count } : {})
    }
  })
}

function channelResource(pluginId: string): string {
  return `channel:${pluginId}`
}

function readWriteInput(value: unknown, reply: boolean): ChannelWriteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
  const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
  const content = typeof item.content === 'string' ? item.content : ''
  const messageId = typeof item.message_id === 'string' ? item.message_id.trim() : ''
  if (
    !pluginId ||
    !chatId ||
    !content.trim() ||
    pluginId.length > 256 ||
    chatId.length > 512 ||
    content.length > 64 * 1024 ||
    (reply && (!messageId || messageId.length > 512)) ||
    (!reply && messageId)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { pluginId, chatId, content, ...(messageId ? { messageId } : {}) }
}

async function executeWriteAction(
  action: 'sendMessage' | 'replyMessage',
  input: ChannelWriteInput,
  workspaceId: string
): Promise<unknown> {
  const { executePluginAction } = await import('../ipc/channel-handlers')
  return executePluginAction({
    pluginId: input.pluginId,
    workspaceId,
    action,
    params: {
      chatId: input.chatId,
      content: input.content,
      ...(input.messageId ? { messageId: input.messageId } : {})
    }
  })
}

export function createChannelReadRuntimeTools(): ToolDefinition[] {
  const getGroupMessages: ToolDefinition = {
    name: 'PluginGetGroupMessages',
    description: 'Read recent messages from a channel chat, limited to the current workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        chat_id: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: MAX_MESSAGES }
      },
      required: ['plugin_id', 'chat_id'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (value) => readInput(value, true),
    resources: async (value) => [channelResource((value as ChannelReadInput).pluginId)],
    execute: async (value, context) =>
      executeReadAction('getGroupMessages', value as ChannelReadInput, context.run.workspaceId)
  }

  const getCurrentChatMessages: ToolDefinition = {
    ...getGroupMessages,
    name: 'PluginGetCurrentChatMessages',
    description: 'Read recent messages from the current channel chat.',
    // The runtime is intentionally stateless with respect to Renderer chat
    // context; requiring chat_id prevents a model from accidentally reading a
    // provider-selected default chat.
    validate: (value) => readInput(value, true)
  }

  const summarizeGroup: ToolDefinition = {
    ...getGroupMessages,
    name: 'PluginSummarizeGroup',
    description: 'Read recent messages from a channel chat for response summarization.'
  }

  const listGroups: ToolDefinition = {
    name: 'PluginListGroups',
    description: 'List available groups for a channel in the current workspace.',
    inputSchema: {
      type: 'object',
      properties: { plugin_id: { type: 'string' } },
      required: ['plugin_id'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (value) => readInput(value, false),
    resources: async (value) => [channelResource((value as ChannelReadInput).pluginId)],
    execute: async (value, context) =>
      executeReadAction('listGroups', value as ChannelReadInput, context.run.workspaceId)
  }

  return [getGroupMessages, getCurrentChatMessages, summarizeGroup, listGroups]
}

export function createChannelWriteRuntimeTools(): ToolDefinition[] {
  const sendMessage: ToolDefinition = {
    name: 'PluginSendMessage',
    description: 'Send a text message to the authorized channel chat for this run.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        chat_id: { type: 'string' },
        content: { type: 'string', minLength: 1, maxLength: 65536 }
      },
      required: ['plugin_id', 'chat_id', 'content'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => readWriteInput(value, false),
    resources: async (value) => [channelResource((value as ChannelWriteInput).pluginId)],
    execute: async (value, context) =>
      trackCronDelivery(
        context,
        'channel',
        () =>
          executeWriteAction('sendMessage', value as ChannelWriteInput, context.run.workspaceId),
        {
          pluginId: (value as ChannelWriteInput).pluginId,
          chatId: (value as ChannelWriteInput).chatId
        }
      )
  }
  const replyMessage: ToolDefinition = {
    ...sendMessage,
    name: 'PluginReplyMessage',
    description: 'Reply to the authorized inbound channel message for this run.',
    inputSchema: {
      ...sendMessage.inputSchema,
      properties: {
        ...(sendMessage.inputSchema.properties as Record<string, unknown>),
        message_id: { type: 'string' }
      },
      required: ['plugin_id', 'chat_id', 'message_id', 'content']
    },
    validate: (value) => readWriteInput(value, true),
    execute: async (value, context) =>
      executeWriteAction('replyMessage', value as ChannelWriteInput, context.run.workspaceId)
  }
  return [sendMessage, replyMessage]
}

export function createChannelProviderReadRuntimeTools(): ToolDefinition[] {
  const listMembers: ToolDefinition = {
    name: 'FeishuListChatMembers',
    description: 'List members in an authorized Feishu chat for mention lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        chat_id: { type: 'string' },
        page_size: { type: 'integer', minimum: 1, maximum: 50 },
        page_token: { type: 'string', maxLength: 4096 },
        member_id_type: { type: 'string', enum: ['open_id', 'user_id', 'union_id'] }
      },
      required: ['plugin_id', 'chat_id'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (value) => {
      const input = readInput(value, true)
      const item = value as Record<string, unknown>
      const pageSize = item.page_size ?? 50
      const pageToken = item.page_token
      const memberIdType = item.member_id_type ?? 'open_id'
      if (
        !Number.isSafeInteger(pageSize) ||
        (pageSize as number) < 1 ||
        (pageSize as number) > 50 ||
        (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 4096)) ||
        !['open_id', 'user_id', 'union_id'].includes(memberIdType as string)
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { ...input, pageSize, ...(pageToken ? { pageToken } : {}), memberIdType }
    },
    resources: async (value) => [channelResource((value as ChannelReadInput).pluginId)],
    execute: async (value, context) => {
      const input = value as ChannelReadInput & {
        pageSize: number
        pageToken?: string
        memberIdType: 'open_id' | 'user_id' | 'union_id'
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool('plugin:feishu:list-members', {
        pluginId: input.pluginId,
        chatId: input.chatId,
        pageSize: input.pageSize,
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        memberIdType: input.memberIdType,
        workspaceId: context.run.workspaceId,
        toolName: 'FeishuListChatMembers'
      })
    }
  }
  const validateBitable = (value: unknown, needsTable: boolean, needsApp = true) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new RuntimeError('INVALID_TOOL_INPUT')
    const item = value as Record<string, unknown>
    const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
    const appToken = typeof item.app_token === 'string' ? item.app_token.trim() : ''
    const tableId = typeof item.table_id === 'string' ? item.table_id.trim() : ''
    if (
      !pluginId ||
      (needsApp && !appToken) ||
      pluginId.length > 256 ||
      appToken.length > 256 ||
      (needsTable && (!tableId || tableId.length > 256))
    )
      throw new RuntimeError('INVALID_TOOL_INPUT')
    return { pluginId, ...(appToken ? { appToken } : {}), ...(tableId ? { tableId } : {}) }
  }
  const makeBitableRead = (
    name: string,
    action: string,
    needsTable: boolean,
    needsApp = true
  ): ToolDefinition => ({
    name,
    description: `Read Feishu Bitable data via ${action}.`,
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', maxLength: 256 },
        app_token: { type: 'string', maxLength: 256 },
        ...(needsTable ? { table_id: { type: 'string', maxLength: 256 } } : {})
      },
      required: needsTable
        ? ['plugin_id', 'app_token', 'table_id']
        : needsApp
          ? ['plugin_id', 'app_token']
          : ['plugin_id'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (value) => validateBitable(value, needsTable, needsApp),
    resources: async (value) => [channelResource((value as { pluginId: string }).pluginId)],
    execute: async (value, context) => {
      const input = value as { pluginId: string; appToken: string; tableId?: string }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool(action, {
        pluginId: input.pluginId,
        ...(input.appToken ? { appToken: input.appToken } : {}),
        ...(input.tableId ? { tableId: input.tableId } : {}),
        workspaceId: context.run.workspaceId,
        toolName: name
      })
    }
  })
  return [
    listMembers,
    makeBitableRead('FeishuBitableListApps', 'plugin:feishu:bitable:list-apps', false, false),
    makeBitableRead('FeishuBitableListTables', 'plugin:feishu:bitable:list-tables', false),
    makeBitableRead('FeishuBitableListFields', 'plugin:feishu:bitable:list-fields', true),
    makeBitableRead('FeishuBitableGetRecords', 'plugin:feishu:bitable:get-records', true)
  ]
}

export function createChannelProviderWriteRuntimeTools(): ToolDefinition[] {
  const sourceExtension = (source: string): string =>
    source.split(/[?#]/, 1)[0].toLowerCase().split('.').at(-1) ?? ''

  const sendImage: ToolDefinition = {
    name: 'FeishuSendImage',
    description: 'Send an image to the authorized Feishu chat using a local path or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        chat_id: { type: 'string' },
        file_path: { type: 'string', minLength: 1, maxLength: 4096 },
        content: { type: 'string', maxLength: 65536 }
      },
      required: ['plugin_id', 'chat_id', 'file_path'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
      const filePath = typeof item.file_path === 'string' ? item.file_path.trim() : ''
      const content = item.content
      if (
        !pluginId ||
        !chatId ||
        !filePath ||
        pluginId.length > 256 ||
        chatId.length > 512 ||
        filePath.length > 4096 ||
        (content !== undefined && (typeof content !== 'string' || content.length > 65536))
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { pluginId, chatId, filePath, ...(typeof content === 'string' ? { content } : {}) }
    },
    resources: async (value) => [channelResource((value as ChannelWriteInput).pluginId)],
    execute: async (value, context) => {
      const input = value as {
        pluginId: string
        chatId: string
        filePath: string
        content?: string
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool('plugin:feishu:send-image', {
        pluginId: input.pluginId,
        chatId: input.chatId,
        filePath: input.filePath,
        ...(input.content ? { content: input.content } : {}),
        workspaceId: context.run.workspaceId,
        toolName: 'FeishuSendImage'
      })
    }
  }
  const sendFile: ToolDefinition = {
    name: 'FeishuSendFile',
    description: 'Send a file to the authorized Feishu chat using a local path or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        chat_id: { type: 'string' },
        file_path: { type: 'string', minLength: 1, maxLength: 4096 },
        file_type: {
          type: 'string',
          enum: ['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream']
        }
      },
      required: ['plugin_id', 'chat_id', 'file_path'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
      const filePath = typeof item.file_path === 'string' ? item.file_path.trim() : ''
      const fileType = item.file_type
      const allowedTypes = new Set(['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream'])
      if (
        !pluginId ||
        !chatId ||
        !filePath ||
        pluginId.length > 256 ||
        chatId.length > 512 ||
        filePath.length > 4096 ||
        (fileType !== undefined && (typeof fileType !== 'string' || !allowedTypes.has(fileType)))
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        pluginId,
        chatId,
        filePath,
        ...(typeof fileType === 'string' ? { fileType } : {})
      }
    },
    resources: async (value) => [channelResource((value as ChannelWriteInput).pluginId)],
    execute: async (value, context) => {
      const input = value as {
        pluginId: string
        chatId: string
        filePath: string
        fileType?: string
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool('plugin:feishu:send-file', {
        pluginId: input.pluginId,
        chatId: input.chatId,
        filePath: input.filePath,
        ...(input.fileType ? { fileType: input.fileType } : {}),
        workspaceId: context.run.workspaceId,
        toolName: 'FeishuSendFile'
      })
    }
  }
  const makeBitableWrite = (
    name: string,
    action: string,
    deleteRecords = false
  ): ToolDefinition => ({
    name,
    description: `Write Feishu Bitable data via ${action}.`,
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', maxLength: 256 },
        app_token: { type: 'string', maxLength: 256 },
        table_id: { type: 'string', maxLength: 256 },
        ...(deleteRecords
          ? { record_ids: { type: 'array', maxItems: 100, items: { type: 'string' } } }
          : { records: { type: 'array', maxItems: 100, items: { type: 'object' } } })
      },
      required: ['plugin_id', 'app_token', 'table_id', deleteRecords ? 'record_ids' : 'records'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const appToken = typeof item.app_token === 'string' ? item.app_token.trim() : ''
      const tableId = typeof item.table_id === 'string' ? item.table_id.trim() : ''
      const payload = deleteRecords ? item.record_ids : item.records
      if (
        !pluginId ||
        !appToken ||
        !tableId ||
        pluginId.length > 256 ||
        appToken.length > 256 ||
        tableId.length > 256 ||
        !Array.isArray(payload) ||
        payload.length < 1 ||
        payload.length > 100
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      if (deleteRecords) {
        if (payload.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256))
          throw new RuntimeError('INVALID_TOOL_INPUT')
      } else if (
        payload.some((record) => !record || typeof record !== 'object' || Array.isArray(record))
      ) {
        throw new RuntimeError('INVALID_TOOL_INPUT')
      }
      if (JSON.stringify(payload).length > 262144) throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        pluginId,
        appToken,
        tableId,
        ...(deleteRecords ? { recordIds: payload } : { records: payload })
      }
    },
    resources: async (value) => [channelResource((value as { pluginId: string }).pluginId)],
    execute: async (value, context) => {
      const input = value as Record<string, unknown>
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool(action, {
        pluginId: input.pluginId,
        appToken: input.appToken,
        tableId: input.tableId,
        ...(deleteRecords ? { recordIds: input.recordIds } : { records: input.records }),
        workspaceId: context.run.workspaceId,
        toolName: name
      })
    }
  })
  const sendMention: ToolDefinition = {
    name: 'FeishuAtMember',
    description: 'Mention authorized Feishu chat members or everyone in a group chat.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', maxLength: 256 },
        chat_id: { type: 'string', maxLength: 512 },
        user_ids: { type: 'array', maxItems: 50, items: { type: 'string' } },
        at_all: { type: 'boolean' },
        text: { type: 'string', maxLength: 65536 }
      },
      required: ['plugin_id', 'chat_id'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
      const userIds = item.user_ids === undefined ? [] : item.user_ids
      const atAll = item.at_all === true
      const text = typeof item.text === 'string' ? item.text : ''
      if (
        !pluginId ||
        !chatId ||
        pluginId.length > 256 ||
        chatId.length > 512 ||
        !Array.isArray(userIds) ||
        userIds.length > 50 ||
        userIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256) ||
        text.length > 65536 ||
        (!atAll && userIds.length === 0 && !text.trim())
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { pluginId, chatId, userIds, atAll, text }
    },
    resources: async (value) => [channelResource((value as { pluginId: string }).pluginId)],
    execute: async (value, context) => {
      const input = value as {
        pluginId: string
        chatId: string
        userIds: string[]
        atAll: boolean
        text: string
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool('plugin:feishu:send-mention', {
        pluginId: input.pluginId,
        chatId: input.chatId,
        userIds: input.userIds,
        atAll: input.atAll,
        text: input.text,
        workspaceId: context.run.workspaceId,
        toolName: 'FeishuAtMember'
      })
    }
  }
  const sendUrgent: ToolDefinition = {
    name: 'FeishuSendUrgent',
    description: 'Send an urgent app or SMS notification for an authorized Feishu message.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', maxLength: 256 },
        message_id: { type: 'string', maxLength: 512 },
        user_ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
        urgent_types: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string', enum: ['app', 'sms'] }
        }
      },
      required: ['plugin_id', 'message_id', 'user_ids', 'urgent_types'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const messageId = typeof item.message_id === 'string' ? item.message_id.trim() : ''
      const userIds = item.user_ids
      const urgentTypes = item.urgent_types
      if (
        !pluginId ||
        !messageId ||
        pluginId.length > 256 ||
        messageId.length > 512 ||
        !Array.isArray(userIds) ||
        userIds.length < 1 ||
        userIds.length > 50 ||
        userIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256) ||
        !Array.isArray(urgentTypes) ||
        urgentTypes.length < 1 ||
        urgentTypes.length > 2 ||
        urgentTypes.some((type) => type !== 'app' && type !== 'sms')
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { pluginId, messageId, userIds, urgentTypes }
    },
    resources: async (value) => [channelResource((value as { pluginId: string }).pluginId)],
    execute: async (value, context) => {
      const input = value as {
        pluginId: string
        messageId: string
        userIds: string[]
        urgentTypes: string[]
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool('plugin:feishu:send-urgent', {
        pluginId: input.pluginId,
        messageId: input.messageId,
        userIds: input.userIds,
        urgentTypes: input.urgentTypes,
        workspaceId: context.run.workspaceId,
        toolName: 'FeishuSendUrgent'
      })
    }
  }
  const makeWeixinMedia = (name: string, action: string): ToolDefinition => ({
    name,
    description: `Send Weixin media through ${action}.`,
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', maxLength: 256 },
        chat_id: { type: 'string', maxLength: 512 },
        file_path: { type: 'string', minLength: 1, maxLength: 4096 },
        content: { type: 'string', maxLength: 65536 }
      },
      required: ['plugin_id', 'chat_id', 'file_path'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
      const filePath = typeof item.file_path === 'string' ? item.file_path.trim() : ''
      const content = item.content
      if (
        !pluginId ||
        !chatId ||
        !filePath ||
        pluginId.length > 256 ||
        chatId.length > 512 ||
        filePath.length > 4096 ||
        (content !== undefined && (typeof content !== 'string' || content.length > 65536))
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { pluginId, chatId, filePath, ...(typeof content === 'string' ? { content } : {}) }
    },
    resources: async (value) => [channelResource((value as { pluginId: string }).pluginId)],
    execute: async (value, context) => {
      const input = value as {
        pluginId: string
        chatId: string
        filePath: string
        content?: string
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool(action, {
        pluginId: input.pluginId,
        chatId: input.chatId,
        filePath: input.filePath,
        ...(input.content ? { content: input.content } : {}),
        workspaceId: context.run.workspaceId,
        toolName: name
      })
    }
  })
  const makeFeishuTypedMedia = (
    name: 'FeishuSendAudio' | 'FeishuSendVideo',
    fileType: 'opus' | 'mp4',
    extensions: readonly string[]
  ): ToolDefinition => ({
    name,
    description: `Send a Feishu ${fileType === 'opus' ? 'voice recording' : 'video'} to the authorized chat.`,
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', maxLength: 256 },
        chat_id: { type: 'string', maxLength: 512 },
        file_path: { type: 'string', minLength: 1, maxLength: 4096 }
      },
      required: ['plugin_id', 'chat_id', 'file_path'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const item = value as Record<string, unknown>
      const pluginId = typeof item.plugin_id === 'string' ? item.plugin_id.trim() : ''
      const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : ''
      const filePath = typeof item.file_path === 'string' ? item.file_path.trim() : ''
      const extension = sourceExtension(filePath)
      if (
        !pluginId ||
        !chatId ||
        !filePath ||
        pluginId.length > 256 ||
        chatId.length > 512 ||
        filePath.length > 4096 ||
        (extension !== '' && !extensions.includes(extension))
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { pluginId, chatId, filePath, fileType }
    },
    resources: async (value) => [channelResource((value as { pluginId: string }).pluginId)],
    execute: async (value, context) => {
      const input = value as {
        pluginId: string
        chatId: string
        filePath: string
        fileType: string
      }
      const { executeChannelSpecificPluginTool } = await import('../ipc/channel-handlers')
      return executeChannelSpecificPluginTool('plugin:feishu:send-file', {
        pluginId: input.pluginId,
        chatId: input.chatId,
        filePath: input.filePath,
        fileType: input.fileType,
        workspaceId: context.run.workspaceId,
        toolName: name
      })
    }
  })
  return [
    sendImage,
    sendFile,
    sendMention,
    sendUrgent,
    makeWeixinMedia('WeixinSendImage', 'plugin:weixin:send-image'),
    makeWeixinMedia('WeixinSendFile', 'plugin:weixin:send-file'),
    makeBitableWrite('FeishuBitableCreateRecords', 'plugin:feishu:bitable:create-records'),
    makeBitableWrite('FeishuBitableUpdateRecords', 'plugin:feishu:bitable:update-records'),
    makeBitableWrite('FeishuBitableDeleteRecords', 'plugin:feishu:bitable:delete-records', true),
    makeFeishuTypedMedia('FeishuSendAudio', 'opus', ['opus']),
    makeFeishuTypedMedia('FeishuSendVideo', 'mp4', ['mp4'])
  ]
}
