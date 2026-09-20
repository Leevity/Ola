import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolRegistry } from '../../src/renderer/src/lib/agent/tool-registry'
import {
  registerPluginTools,
  unregisterPluginTools
} from '../../src/renderer/src/lib/channel/plugin-tools'
import { IPC } from '../../src/renderer/src/lib/ipc/channels'

afterEach(() => {
  unregisterPluginTools()
})

describe('renderer channel tool bridge', () => {
  it('routes common plugin tools through the workspace-scoped Main action', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ messageId: 'sent-1' }))
    const handler = toolRegistry.get('PluginSendMessage')
    expect(handler).toBeDefined()
    await expect(
      handler!.execute(
        { plugin_id: 'plugin-a', chat_id: 'chat-a', content: 'hello' },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ messageId: 'sent-1' }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_EXEC, {
      pluginId: 'plugin-a',
      action: 'sendMessage',
      params: { chatId: 'chat-a', content: 'hello' }
    })
  })

  it('requires an explicit chat target for replies', () => {
    registerPluginTools()
    const handler = toolRegistry.get('PluginReplyMessage')
    const schema = handler?.definition.inputSchema
    expect(
      schema && schema.type === 'object' && 'required' in schema ? schema.required : undefined
    ).toEqual(['plugin_id', 'chat_id', 'message_id', 'content'])
  })

  it('routes summarize and current-chat reads through the Main action', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => [{ id: 'message-1' }])
    for (const toolName of ['PluginSummarizeGroup', 'PluginGetCurrentChatMessages']) {
      const handler = toolRegistry.get(toolName)
      await expect(
        handler!.execute(
          { plugin_id: 'plugin-a', chat_id: 'chat-a', count: 10 },
          { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
        )
      ).resolves.toBe(JSON.stringify([{ id: 'message-1' }]))
    }
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenNthCalledWith(1, IPC.PLUGIN_EXEC, {
      pluginId: 'plugin-a',
      action: 'getGroupMessages',
      params: { chatId: 'chat-a', count: 10 }
    })
  })

  it('routes Feishu file sends through the provider IPC bridge', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ ok: true, messageId: 'file-1' }))
    const handler = toolRegistry.get('FeishuSendFile')
    expect(handler).toBeDefined()
    await expect(
      handler!.execute(
        {
          plugin_id: 'plugin-a',
          chat_id: 'chat-a',
          file_path: '/tmp/report.pdf',
          file_type: 'pdf'
        },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ ok: true, messageId: 'file-1' }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_FEISHU_SEND_FILE, {
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      filePath: '/tmp/report.pdf',
      fileType: 'pdf'
    })
  })

  it('routes Feishu Bitable reads through provider IPC', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ ok: true, data: [] }))
    const handler = toolRegistry.get('FeishuBitableListApps')
    await expect(
      handler!.execute(
        { plugin_id: 'plugin-a' },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ ok: true, data: [] }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_FEISHU_BITABLE_LIST_APPS, {
      pluginId: 'plugin-a'
    })
  })

  it('routes Feishu Bitable writes through provider IPC', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ ok: true, data: [] }))
    const handler = toolRegistry.get('FeishuBitableCreateRecords')
    await expect(
      handler!.execute(
        {
          plugin_id: 'plugin-a',
          app_token: 'app-a',
          table_id: 'table-a',
          records: [{ Name: 'Ada' }]
        },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ ok: true, data: [] }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_FEISHU_BITABLE_CREATE_RECORDS, {
      pluginId: 'plugin-a',
      appToken: 'app-a',
      tableId: 'table-a',
      records: [{ Name: 'Ada' }]
    })
  })

  it('routes Feishu mentions through provider IPC', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ ok: true, messageId: 'mention-1' }))
    const handler = toolRegistry.get('FeishuAtMember')
    await expect(
      handler!.execute(
        { plugin_id: 'plugin-a', chat_id: 'chat-a', user_ids: ['ou_a'], text: 'hello' },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ ok: true, messageId: 'mention-1' }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_FEISHU_SEND_MENTION, {
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      userIds: ['ou_a'],
      atAll: undefined,
      text: 'hello'
    })
  })

  it('routes Feishu urgent notifications through provider IPC', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ ok: true }))
    const handler = toolRegistry.get('FeishuSendUrgent')
    await expect(
      handler!.execute(
        {
          plugin_id: 'plugin-a',
          message_id: 'message-a',
          user_ids: ['user-a'],
          urgent_types: ['app']
        },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ ok: true }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_FEISHU_SEND_URGENT, {
      pluginId: 'plugin-a',
      messageId: 'message-a',
      userIds: ['user-a'],
      urgentTypes: ['app']
    })
  })

  it('routes Weixin image sends through provider IPC', async () => {
    registerPluginTools()
    const invoke = vi.fn(async () => ({ ok: true, messageId: 'wx-1' }))
    const handler = toolRegistry.get('WeixinSendImage')
    await expect(
      handler!.execute(
        {
          plugin_id: 'weixin-a',
          chat_id: 'chat-a',
          file_path: '/tmp/a.png',
          content: 'caption'
        },
        { signal: new AbortController().signal, ipc: { invoke, send: vi.fn(), on: vi.fn() } }
      )
    ).resolves.toBe(JSON.stringify({ ok: true, messageId: 'wx-1' }))
    expect(invoke).toHaveBeenCalledWith(IPC.PLUGIN_WEIXIN_SEND_IMAGE, {
      pluginId: 'weixin-a',
      chatId: 'chat-a',
      filePath: '/tmp/a.png',
      content: 'caption'
    })
  })
})
