import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from '../tools/tool-types'
import { IPC } from '../ipc/channels'

// ── 5 Unified Plugin Tools ──
// All provider-agnostic — route via plugin_id to the correct backend service

async function executeMainPluginAction(
  action: 'sendMessage' | 'replyMessage' | 'getGroupMessages' | 'listGroups',
  input: Record<string, unknown>,
  ctx: Parameters<NonNullable<ToolHandler['execute']>>[1]
): Promise<string> {
  const pluginId = typeof input.plugin_id === 'string' ? input.plugin_id.trim() : ''
  const chatId = typeof input.chat_id === 'string' ? input.chat_id.trim() : ''
  if (!pluginId || (action !== 'listGroups' && !chatId))
    return JSON.stringify({ error: 'Invalid plugin action input' })
  try {
    const result = await ctx.ipc.invoke(IPC.PLUGIN_EXEC, {
      pluginId,
      action,
      params: {
        ...(chatId ? { chatId } : {}),
        ...(typeof input.content === 'string' ? { content: input.content } : {}),
        ...(typeof input.message_id === 'string' ? { messageId: input.message_id } : {}),
        ...(typeof input.count === 'number' ? { count: input.count } : {})
      }
    })
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  }
}

async function executeFeishuBitable(
  channel: string,
  input: Record<string, unknown>,
  ctx: Parameters<NonNullable<ToolHandler['execute']>>[1]
): Promise<string> {
  const pluginId = typeof input.plugin_id === 'string' ? input.plugin_id.trim() : ''
  const appToken = typeof input.app_token === 'string' ? input.app_token.trim() : ''
  const tableId = typeof input.table_id === 'string' ? input.table_id.trim() : ''
  const records = input.records
  const recordIds = input.record_ids
  if (
    !pluginId ||
    (channel !== IPC.PLUGIN_FEISHU_BITABLE_LIST_APPS && !appToken) ||
    ((channel.includes('list-fields') ||
      channel.includes('get-records') ||
      channel.includes('records')) &&
      !tableId) ||
    ((channel.includes('create-records') || channel.includes('update-records')) &&
      !Array.isArray(records)) ||
    (channel.includes('delete-records') && !Array.isArray(recordIds))
  )
    return JSON.stringify({ error: 'Invalid Feishu Bitable input' })
  try {
    const result = await ctx.ipc.invoke(channel, {
      pluginId,
      ...(appToken ? { appToken } : {}),
      ...(tableId ? { tableId } : {}),
      ...(Array.isArray(records) ? { records } : {}),
      ...(Array.isArray(recordIds) ? { recordIds } : {})
    })
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  }
}

const pluginSendMessage: ToolHandler = {
  definition: {
    name: 'PluginSendMessage',
    description:
      'Send a message to a chat/group via a messaging channel (Feishu, DingTalk, etc.). Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to send the message to' },
        content: { type: 'string', description: 'The message content to send' }
      },
      required: ['plugin_id', 'chat_id', 'content']
    }
  },
  execute: async (input, ctx) => executeMainPluginAction('sendMessage', input, ctx),
  requiresApproval: () => true
}

const pluginReplyMessage: ToolHandler = {
  definition: {
    name: 'PluginReplyMessage',
    description: 'Reply to a specific message via a messaging channel. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' },
        message_id: { type: 'string', description: 'The message ID to reply to' },
        content: { type: 'string', description: 'The reply content' }
      },
      required: ['plugin_id', 'chat_id', 'message_id', 'content']
    }
  },
  execute: async (input, ctx) => executeMainPluginAction('replyMessage', input, ctx),
  requiresApproval: () => true
}

const pluginGetGroupMessages: ToolHandler = {
  definition: {
    name: 'PluginGetGroupMessages',
    description: 'Get recent messages from a chat/group via a messaging channel.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to get messages from' },
        count: { type: 'number', description: 'Number of messages to retrieve (default 20)' }
      },
      required: ['plugin_id', 'chat_id']
    }
  },
  execute: async (input, ctx) => executeMainPluginAction('getGroupMessages', input, ctx)
}

const pluginListGroups: ToolHandler = {
  definition: {
    name: 'PluginListGroups',
    description: 'List all available groups/chats for a messaging channel.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' }
      },
      required: ['plugin_id']
    }
  },
  execute: async (input, ctx) => executeMainPluginAction('listGroups', input, ctx)
}

const pluginSummarizeGroup: ToolHandler = {
  definition: {
    name: 'PluginSummarizeGroup',
    description:
      'Get recent messages from a group and provide them for summarization. Returns raw messages — you should summarize them in your response.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to summarize' },
        count: {
          type: 'number',
          description: 'Number of recent messages to include (default 50)'
        }
      },
      required: ['plugin_id', 'chat_id']
    }
  },
  execute: async (input, ctx) => executeMainPluginAction('getGroupMessages', input, ctx)
}

const pluginGetCurrentChatMessages: ToolHandler = {
  definition: {
    name: 'PluginGetCurrentChatMessages',
    description: 'Get recent messages from the current channel chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: {
          type: 'string',
          description: 'The channel instance ID to use (optional, defaults to current)'
        },
        chat_id: {
          type: 'string',
          description: 'The chat/group ID to read'
        },
        count: { type: 'number', description: 'Number of messages to retrieve (default 20)' }
      },
      required: ['plugin_id', 'chat_id']
    }
  },
  execute: async (input, ctx) => executeMainPluginAction('getGroupMessages', input, ctx)
}

// ── Feishu-specific Media Tools ──

const feishuSendImage: ToolHandler = {
  definition: {
    name: 'FeishuSendImage',
    description:
      'Send an image to a Feishu chat. Accepts either an absolute local file path (e.g. /home/user/pic.png or C:\\Users\\...\\pic.png) or an HTTP/HTTPS URL (e.g. https://example.com/image.png). The tool automatically downloads URLs and uploads the image to Feishu.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        chat_id: { type: 'string', description: 'The Feishu chat ID to send the image to' },
        file_path: {
          type: 'string',
          description: 'Absolute local file path OR an HTTP/HTTPS URL pointing to the image'
        }
      },
      required: ['plugin_id', 'chat_id', 'file_path']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_IMAGE, {
        pluginId: input.plugin_id,
        chatId: input.chat_id,
        filePath: input.file_path,
        content: input.content
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  requiresApproval: () => true
}

const feishuSendFile: ToolHandler = {
  definition: {
    name: 'FeishuSendFile',
    description:
      'Send a file to a Feishu chat. Accepts either an absolute local file path (e.g. /home/user/doc.pdf) or an HTTP/HTTPS URL (e.g. https://example.com/report.pdf). The tool automatically downloads URLs, detects the file type from the extension (pdf, doc/docx, xls/xlsx, ppt/pptx, mp4, opus → stream for others), and uploads to Feishu.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        chat_id: { type: 'string', description: 'The Feishu chat ID to send the file to' },
        file_path: {
          type: 'string',
          description: 'Absolute local file path OR an HTTP/HTTPS URL pointing to the file'
        },
        file_type: {
          type: 'string',
          description:
            'Override file type: opus, mp4, pdf, doc, xls, ppt, or stream. Omit to auto-detect from extension.',
          enum: ['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream']
        }
      },
      required: ['plugin_id', 'chat_id', 'file_path']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_FILE, {
        pluginId: input.plugin_id,
        chatId: input.chat_id,
        filePath: input.file_path,
        fileType: input.file_type
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  requiresApproval: () => true
}

const weixinSendImage: ToolHandler = {
  definition: {
    name: 'WeixinSendImage',
    description:
      'Send an image to an official Weixin chat. Accepts either an absolute local file path or an HTTP/HTTPS URL. Optionally send `content` as a text message before the image.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The official Weixin channel instance ID' },
        chat_id: { type: 'string', description: 'The Weixin chat ID to send the image to' },
        file_path: {
          type: 'string',
          description: 'Absolute local file path OR an HTTP/HTTPS URL pointing to the image'
        },
        content: {
          type: 'string',
          description: 'Optional text to send before the image as a separate text message'
        }
      },
      required: ['plugin_id', 'chat_id', 'file_path']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_WEIXIN_SEND_IMAGE, {
        pluginId: input.plugin_id,
        chatId: input.chat_id,
        filePath: input.file_path,
        content: input.content
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  requiresApproval: () => true
}

const weixinSendFile: ToolHandler = {
  definition: {
    name: 'WeixinSendFile',
    description:
      'Send a file to an official Weixin chat. Accepts either an absolute local file path or an HTTP/HTTPS URL. Optionally send `content` as a text message before the file.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The official Weixin channel instance ID' },
        chat_id: { type: 'string', description: 'The Weixin chat ID to send the file to' },
        file_path: {
          type: 'string',
          description: 'Absolute local file path OR an HTTP/HTTPS URL pointing to the file'
        },
        content: {
          type: 'string',
          description: 'Optional text to send before the file as a separate text message'
        }
      },
      required: ['plugin_id', 'chat_id', 'file_path']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_WEIXIN_SEND_FILE, {
        pluginId: input.plugin_id,
        chatId: input.chat_id,
        filePath: input.file_path,
        content: input.content
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  requiresApproval: () => true
}

const feishuListChatMembers: ToolHandler = {
  definition: {
    name: 'FeishuListChatMembers',
    description: 'List members in a Feishu chat/group. Returns member IDs for @mentions.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        chat_id: {
          type: 'string',
          description: 'The Feishu chat ID (optional, defaults to current)'
        },
        page_size: { type: 'number', description: 'Page size (1-50, default 50)' },
        page_token: { type: 'string', description: 'Pagination token' },
        member_id_type: {
          type: 'string',
          enum: ['open_id', 'user_id', 'union_id'],
          description: 'Member ID type (default open_id)'
        }
      },
      required: ['plugin_id']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_LIST_MEMBERS, {
        pluginId: input.plugin_id,
        chatId: input.chat_id,
        pageSize: input.page_size,
        pageToken: input.page_token,
        memberIdType: input.member_id_type
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}

const feishuAtMember: ToolHandler = {
  definition: {
    name: 'FeishuAtMember',
    description:
      'Mention members in a Feishu group chat (group-only). Use FeishuListChatMembers to get open_id values.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        chat_id: {
          type: 'string',
          description: 'The Feishu chat ID (optional, defaults to current)'
        },
        user_ids: { type: 'array', items: { type: 'string' }, description: 'User IDs to mention' },
        at_all: { type: 'boolean', description: 'Mention all members' },
        text: { type: 'string', description: 'Message text to send (without @ tags)' }
      },
      required: ['plugin_id', 'text']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_MENTION, {
        pluginId: input.plugin_id,
        chatId: input.chat_id,
        userIds: input.user_ids,
        atAll: input.at_all,
        text: input.text
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  requiresApproval: () => true
}

const feishuSendUrgent: ToolHandler = {
  definition: {
    name: 'FeishuSendUrgent',
    description: 'Send urgent push (app/sms) to Feishu message recipients.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        message_id: { type: 'string', description: 'Target message_id for urgent push' },
        user_ids: { type: 'array', items: { type: 'string' }, description: 'User IDs to notify' },
        urgent_types: {
          type: 'array',
          items: { type: 'string', enum: ['app', 'sms'] },
          description: 'Urgent types to send (app, sms)'
        }
      },
      required: ['plugin_id', 'message_id', 'user_ids', 'urgent_types']
    }
  },
  execute: async (input, ctx) => {
    try {
      const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_URGENT, {
        pluginId: input.plugin_id,
        messageId: input.message_id,
        userIds: input.user_ids,
        urgentTypes: input.urgent_types
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  requiresApproval: () => true
}

const feishuBitableListApps: ToolHandler = {
  definition: {
    name: 'FeishuBitableListApps',
    description: 'List accessible Feishu Bitable apps.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' }
      },
      required: ['plugin_id']
    }
  },
  execute: (input, ctx) => executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_LIST_APPS, input, ctx)
}

const feishuBitableListTables: ToolHandler = {
  definition: {
    name: 'FeishuBitableListTables',
    description: 'List tables in a Feishu Bitable app.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' }
      },
      required: ['plugin_id', 'app_token']
    }
  },
  execute: (input, ctx) => executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_LIST_TABLES, input, ctx)
}

const feishuBitableListFields: ToolHandler = {
  definition: {
    name: 'FeishuBitableListFields',
    description: 'List fields for a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' }
      },
      required: ['plugin_id', 'app_token', 'table_id']
    }
  },
  execute: (input, ctx) => executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_LIST_FIELDS, input, ctx)
}

const feishuBitableGetRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableGetRecords',
    description: 'Get records from a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        filter: { type: 'string', description: 'Optional filter formula' },
        page_size: { type: 'number', description: 'Page size (default 50)' },
        page_token: { type: 'string', description: 'Page token for pagination' }
      },
      required: ['plugin_id', 'app_token', 'table_id']
    }
  },
  execute: (input, ctx) => executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_GET_RECORDS, input, ctx)
}

const feishuBitableCreateRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableCreateRecords',
    description: 'Create records in a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        records: {
          type: 'array',
          description: 'Records payload array',
          items: { type: 'object', description: 'Record payload object' }
        }
      },
      required: ['plugin_id', 'app_token', 'table_id', 'records']
    }
  },
  execute: (input, ctx) =>
    executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_CREATE_RECORDS, input, ctx)
}

const feishuBitableUpdateRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableUpdateRecords',
    description: 'Update records in a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        records: {
          type: 'array',
          description: 'Records payload array',
          items: { type: 'object', description: 'Record payload object' }
        }
      },
      required: ['plugin_id', 'app_token', 'table_id', 'records']
    }
  },
  execute: (input, ctx) =>
    executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_UPDATE_RECORDS, input, ctx)
}

const feishuBitableDeleteRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableDeleteRecords',
    description: 'Delete records from a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu channel instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        record_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Record IDs to delete'
        }
      },
      required: ['plugin_id', 'app_token', 'table_id', 'record_ids']
    }
  },
  execute: (input, ctx) =>
    executeFeishuBitable(IPC.PLUGIN_FEISHU_BITABLE_DELETE_RECORDS, input, ctx)
}

const FEISHU_TOOLS: ToolHandler[] = [
  feishuSendImage,
  feishuSendFile,
  feishuListChatMembers,
  feishuAtMember,
  feishuSendUrgent,
  feishuBitableListApps,
  feishuBitableListTables,
  feishuBitableListFields,
  feishuBitableGetRecords,
  feishuBitableCreateRecords,
  feishuBitableUpdateRecords,
  feishuBitableDeleteRecords
]

const WEIXIN_TOOLS: ToolHandler[] = [weixinSendImage, weixinSendFile]
const COMMON_PLUGIN_TOOL_NAMES = [
  pluginSendMessage,
  pluginReplyMessage,
  pluginGetGroupMessages,
  pluginListGroups,
  pluginSummarizeGroup,
  pluginGetCurrentChatMessages
].map((tool) => tool.definition.name)
const FEISHU_PLUGIN_TOOL_NAMES = [
  ...COMMON_PLUGIN_TOOL_NAMES,
  ...FEISHU_TOOLS.map((tool) => tool.definition.name)
]
const WEIXIN_PLUGIN_TOOL_NAMES = [
  ...COMMON_PLUGIN_TOOL_NAMES,
  ...WEIXIN_TOOLS.map((tool) => tool.definition.name)
]

const ALL_PLUGIN_TOOLS: ToolHandler[] = [
  pluginSendMessage,
  pluginReplyMessage,
  pluginGetGroupMessages,
  pluginListGroups,
  pluginSummarizeGroup,
  pluginGetCurrentChatMessages,
  ...WEIXIN_TOOLS,
  ...FEISHU_TOOLS
]

export const PLUGIN_TOOL_DEFINITIONS = ALL_PLUGIN_TOOLS.map((tool) => ({
  name: tool.definition.name,
  description: tool.definition.description
}))

export function getDefaultPluginToolNamesForType(pluginType?: string): string[] {
  const type = (pluginType ?? '').toLowerCase()
  if (type === 'weixin-official') return [...WEIXIN_PLUGIN_TOOL_NAMES]
  if (type === 'feishu-bot' || type === 'feishu') return [...FEISHU_PLUGIN_TOOL_NAMES]
  return [...COMMON_PLUGIN_TOOL_NAMES]
}

let _registered = false

export function registerPluginTools(): void {
  if (_registered) return
  _registered = true
  for (const tool of ALL_PLUGIN_TOOLS) {
    const readOnly = /^(?:Plugin(?:Get|List|Summarize)|FeishuList|FeishuBitable(?:List|Get))/.test(
      tool.definition.name
    )
    toolRegistry.register(tool, {
      namespace: 'channel',
      owner: 'channel:plugin-tools',
      capability: {
        readOnly,
        riskLevel: readOnly ? 'low' : 'high',
        requiresApproval: !readOnly,
        projectScoped: true
      }
    })
  }
}

export function unregisterPluginTools(): void {
  if (!_registered) return
  _registered = false
  for (const tool of ALL_PLUGIN_TOOLS) {
    toolRegistry.unregister(tool.definition.name, 'channel:plugin-tools')
  }
}

export function isPluginToolsRegistered(): boolean {
  return _registered
}
