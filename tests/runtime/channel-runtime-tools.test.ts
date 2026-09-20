import { describe, expect, it, vi } from 'vitest'
import {
  createChannelProviderReadRuntimeTools,
  createChannelProviderWriteRuntimeTools,
  createChannelReadRuntimeTools,
  createChannelWriteRuntimeTools
} from '../../src/main/runtime/channel-runtime-tools'

const executePluginAction = vi.fn(async (args: Record<string, unknown>) => ({
  ok: true,
  args
}))

vi.mock('../../src/main/ipc/channel-handlers', () => ({ executePluginAction }))

describe('TS channel read runtime tools', () => {
  it('exposes only workspace-scoped read tools with bounded input', () => {
    const tools = createChannelReadRuntimeTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'PluginGetGroupMessages',
      'PluginGetCurrentChatMessages',
      'PluginSummarizeGroup',
      'PluginListGroups'
    ])
    expect(tools[0].validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', count: 100 })).toEqual({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      count: 100
    })
    expect(() =>
      tools[0].validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', count: 101 })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('requires an explicit chat id for current-chat reads', () => {
    const tool = createChannelReadRuntimeTools()[1]
    expect(tool.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a' })).toEqual({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      count: 20
    })
    expect(() => tool.validate({ plugin_id: 'plugin-a' })).toThrow('INVALID_TOOL_INPUT')
  })
})

describe('TS channel write runtime tools', () => {
  it('validates bounded send and reply payloads', () => {
    const tools = createChannelWriteRuntimeTools()
    expect(tools.map((tool) => tool.name)).toEqual(['PluginSendMessage', 'PluginReplyMessage'])
    expect(
      tools[0].validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', content: 'hello' })
    ).toEqual({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      content: 'hello'
    })
    expect(
      tools[1].validate({
        plugin_id: 'plugin-a',
        chat_id: 'chat-a',
        message_id: 'message-a',
        content: 'reply'
      })
    ).toEqual({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      messageId: 'message-a',
      content: 'reply'
    })
    expect(() =>
      tools[0].validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', content: '' })
    ).toThrow('INVALID_TOOL_INPUT')
    expect(() =>
      tools[1].validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', content: 'reply' })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('routes validated writes through the Main workspace-authorized action', async () => {
    const [send, reply] = createChannelWriteRuntimeTools()
    const context = {
      run: { workspaceId: 'team-a' },
      signal: new AbortController().signal
    } as never
    await expect(
      send.execute(
        send.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', content: 'hello' }),
        context
      )
    ).resolves.toMatchObject({ ok: true })
    await expect(
      reply.execute(
        reply.validate({
          plugin_id: 'plugin-a',
          chat_id: 'chat-a',
          message_id: 'message-a',
          content: 'reply'
        }),
        context
      )
    ).resolves.toMatchObject({ ok: true })
    expect(executePluginAction).toHaveBeenNthCalledWith(1, {
      pluginId: 'plugin-a',
      workspaceId: 'team-a',
      action: 'sendMessage',
      params: { chatId: 'chat-a', content: 'hello' }
    })
    expect(executePluginAction).toHaveBeenNthCalledWith(2, {
      pluginId: 'plugin-a',
      workspaceId: 'team-a',
      action: 'replyMessage',
      params: { chatId: 'chat-a', messageId: 'message-a', content: 'reply' }
    })
  })
})

describe('TS provider channel read runtime tools', () => {
  it('validates Feishu member listing pagination and identity type', () => {
    const [tool] = createChannelProviderReadRuntimeTools()
    expect(
      tool.validate({
        plugin_id: 'plugin-a',
        chat_id: 'chat-a',
        page_size: 20,
        member_id_type: 'open_id'
      })
    ).toMatchObject({ pluginId: 'plugin-a', chatId: 'chat-a', pageSize: 20 })
    expect(() =>
      tool.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', page_size: 51 })
    ).toThrow('INVALID_TOOL_INPUT')
    expect(() =>
      tool.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', member_id_type: 'email' })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('exposes bounded Feishu Bitable read tools', () => {
    const tools = createChannelProviderReadRuntimeTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'FeishuListChatMembers',
      'FeishuBitableListApps',
      'FeishuBitableListTables',
      'FeishuBitableListFields',
      'FeishuBitableGetRecords'
    ])
    expect(tools[1].validate({ plugin_id: 'plugin-a' })).toEqual({ pluginId: 'plugin-a' })
    expect(
      tools[3].validate({ plugin_id: 'plugin-a', app_token: 'app-a', table_id: 'table-a' })
    ).toEqual({ pluginId: 'plugin-a', appToken: 'app-a', tableId: 'table-a' })
    expect(() => tools[3].validate({ plugin_id: 'plugin-a', app_token: 'app-a' })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })
})

describe('TS provider channel write runtime tools', () => {
  it('validates bounded Feishu image input', () => {
    const [tool] = createChannelProviderWriteRuntimeTools()
    expect(
      tool.validate({
        plugin_id: 'plugin-a',
        chat_id: 'chat-a',
        file_path: 'https://example.test/image.png'
      })
    ).toEqual({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      filePath: 'https://example.test/image.png'
    })
    expect(() =>
      tool.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', file_path: '' })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('validates Feishu file type overrides', () => {
    const [, tool] = createChannelProviderWriteRuntimeTools()
    expect(
      tool.validate({
        plugin_id: 'plugin-a',
        chat_id: 'chat-a',
        file_path: '/tmp/report.pdf',
        file_type: 'pdf'
      })
    ).toEqual({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      filePath: '/tmp/report.pdf',
      fileType: 'pdf'
    })
    expect(() =>
      tool.validate({
        plugin_id: 'plugin-a',
        chat_id: 'chat-a',
        file_path: '/tmp/report.pdf',
        file_type: 'exe'
      })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('validates bounded Bitable write payloads', () => {
    const tools = createChannelProviderWriteRuntimeTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'FeishuSendImage',
      'FeishuSendFile',
      'FeishuAtMember',
      'FeishuSendUrgent',
      'WeixinSendImage',
      'WeixinSendFile',
      'FeishuBitableCreateRecords',
      'FeishuBitableUpdateRecords',
      'FeishuBitableDeleteRecords',
      'FeishuSendAudio',
      'FeishuSendVideo'
    ])
    expect(
      tools[6].validate({
        plugin_id: 'plugin-a',
        app_token: 'app-a',
        table_id: 'table-a',
        records: [{ Name: 'Ada' }]
      })
    ).toMatchObject({ pluginId: 'plugin-a', appToken: 'app-a', tableId: 'table-a' })
    expect(() =>
      tools[8].validate({
        plugin_id: 'plugin-a',
        app_token: 'app-a',
        table_id: 'table-a',
        record_ids: []
      })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('validates Feishu mention targets and content', () => {
    const tool = createChannelProviderWriteRuntimeTools()[2]
    expect(
      tool.validate({
        plugin_id: 'plugin-a',
        chat_id: 'chat-a',
        user_ids: ['ou_a'],
        text: 'hello'
      })
    ).toMatchObject({ pluginId: 'plugin-a', chatId: 'chat-a', userIds: ['ou_a'] })
    expect(() => tool.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a' })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })

  it('validates urgent message recipients and types', () => {
    const tool = createChannelProviderWriteRuntimeTools()[3]
    expect(
      tool.validate({
        plugin_id: 'plugin-a',
        message_id: 'message-a',
        user_ids: ['user-a'],
        urgent_types: ['app']
      })
    ).toMatchObject({ pluginId: 'plugin-a', messageId: 'message-a' })
    expect(() =>
      tool.validate({
        plugin_id: 'plugin-a',
        message_id: 'message-a',
        user_ids: [],
        urgent_types: ['app']
      })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('validates Weixin media paths and optional content', () => {
    const tool = createChannelProviderWriteRuntimeTools()[4]
    expect(
      tool.validate({
        plugin_id: 'weixin-a',
        chat_id: 'chat-a',
        file_path: 'https://example.test/a.png',
        content: 'caption'
      })
    ).toMatchObject({
      pluginId: 'weixin-a',
      chatId: 'chat-a',
      filePath: 'https://example.test/a.png'
    })
    expect(() =>
      tool.validate({ plugin_id: 'weixin-a', chat_id: 'chat-a', file_path: '' })
    ).toThrow('INVALID_TOOL_INPUT')
  })

  it('validates explicit Feishu audio and video media types', () => {
    const tools = createChannelProviderWriteRuntimeTools()
    const audio = tools.find((tool) => tool.name === 'FeishuSendAudio')!
    const video = tools.find((tool) => tool.name === 'FeishuSendVideo')!
    expect(
      audio.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', file_path: '/tmp/voice.opus' })
    ).toMatchObject({ pluginId: 'plugin-a', chatId: 'chat-a', fileType: 'opus' })
    expect(
      video.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', file_path: '/tmp/clip.mp4' })
    ).toMatchObject({ pluginId: 'plugin-a', chatId: 'chat-a', fileType: 'mp4' })
    expect(() =>
      audio.validate({ plugin_id: 'plugin-a', chat_id: 'chat-a', file_path: '/tmp/clip.mp4' })
    ).toThrow('INVALID_TOOL_INPUT')
  })
})
