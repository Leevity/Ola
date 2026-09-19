import { describe, expect, it } from 'vitest'
import { isAuthorizedDesktopRuntimeTool } from '../../src/main/runtime/runtime-tool-authorization'
import type { RunSpec } from '../../src/shared/runtime/contracts'

const run = (taskId: string, unattended = true): RunSpec => ({
  runId: 'run',
  taskId,
  requestId: 'request',
  traceId: 'trace',
  sessionId: 'session',
  workspaceId: 'local-personal',
  environmentId: 'local',
  prompt: 'prompt',
  unattended,
  modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
})

describe('desktop runtime tool authorization', () => {
  it('allows reads and the fixed Cron notification capability', () => {
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: run('cron:job'),
        tool: { name: 'Read', effect: 'read' },
        input: {}
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: run('cron:job'),
        tool: { name: 'Notify', effect: 'write' },
        input: {}
      })
    ).toBe(true)
  })

  it('requires explicit policy grants for Cron filesystem and shell side effects', () => {
    const policy = {
      enabled: true,
      whitelistedTools: ['Write'],
      bashAllowRules: [{ pattern: 'git status*', mode: 'wildcard' as const }],
      bashDenyRules: []
    }
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: run('cron:job'),
        tool: { name: 'Write', effect: 'write' },
        input: { path: 'x' },
        permissionPolicy: policy
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: run('cron:job'),
        tool: { name: 'Bash', effect: 'write' },
        input: { command: 'git status --short' },
        permissionPolicy: policy
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: run('cron:job'),
        tool: { name: 'Bash', effect: 'write' },
        input: { command: 'rm -rf x' },
        permissionPolicy: policy
      })
    ).toBe(false)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: run('chat:job'),
        tool: { name: 'Write', effect: 'write' },
        input: { path: 'x' },
        permissionPolicy: policy
      })
    ).toBe(false)
  })

  it('only authorizes channel writes for the exact Main-bound target', () => {
    const channelRun = {
      ...run('channel:auto-reply'),
      toolNames: [
        'PluginSendMessage',
        'PluginReplyMessage',
        'FeishuSendImage',
        'FeishuSendFile',
        'FeishuBitableCreateRecords'
      ],
      channelContext: { pluginId: 'plugin-a', chatId: 'chat-a', messageId: 'message-a' }
    }
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: channelRun,
        tool: { name: 'PluginSendMessage', effect: 'write' },
        input: { plugin_id: 'plugin-a', chat_id: 'chat-a', content: 'hello' }
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: channelRun,
        tool: { name: 'FeishuBitableCreateRecords', effect: 'write' },
        input: {
          plugin_id: 'plugin-a',
          app_token: 'app-a',
          table_id: 'table-a',
          records: [{ Name: 'Ada' }]
        }
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: channelRun,
        tool: { name: 'FeishuSendFile', effect: 'write' },
        input: { plugin_id: 'plugin-a', chat_id: 'chat-a', file_path: '/tmp/a.pdf' }
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: channelRun,
        tool: { name: 'PluginReplyMessage', effect: 'write' },
        input: {
          plugin_id: 'plugin-a',
          chat_id: 'chat-a',
          message_id: 'message-b',
          content: 'hello'
        }
      })
    ).toBe(false)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: channelRun,
        tool: { name: 'FeishuSendImage', effect: 'write' },
        input: {
          plugin_id: 'plugin-a',
          chat_id: 'chat-a',
          file_path: '/tmp/image.png'
        }
      })
    ).toBe(true)
  })
})
