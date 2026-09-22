import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('authorizes translation buffer writes only for an interactive translation run', () => {
    const translationRun = {
      ...run('translation-task', false),
      toolNames: ['Write', 'Edit', 'Read', 'FileRead'],
      translationContext: { sourceLanguage: 'auto', targetLanguage: 'en' }
    }
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: translationRun,
        tool: { name: 'Write', effect: 'write' },
        input: { content: 'hello' }
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: { ...translationRun, unattended: true },
        tool: { name: 'Write', effect: 'write' },
        input: { content: 'hello' }
      })
    ).toBe(false)
  })

  it('requires an explicit interactive tool snapshot for prompt optimization writes', () => {
    const optimizerRun = { ...run('optimizer-task', false), toolNames: ['WriteOptimizedPrompts'] }
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: optimizerRun,
        tool: { name: 'WriteOptimizedPrompts', effect: 'write' },
        input: { options: [] }
      })
    ).toBe(true)
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: { ...optimizerRun, unattended: true },
        tool: { name: 'WriteOptimizedPrompts', effect: 'write' },
        input: { options: [] }
      })
    ).toBe(false)
  })
  it('applies capability policy as a deny gate on interactive write tools', () => {
    // A translation run grants Write in its snapshot, but the shared Capability
    // policy still vetoes path escapes — foreground runs no longer bypass it.
    const root = mkdtempSync(join(tmpdir(), 'ola-auth-'))
    const translationRun = {
      ...run('translation-task', false),
      toolNames: ['Write'],
      workingDirectory: root,
      translationContext: { sourceLanguage: 'auto', targetLanguage: 'en' }
    }
    const policy = {
      enabled: true,
      whitelistedTools: [],
      bashAllowRules: [],
      bashDenyRules: []
    }
    // A contained path keeps the snapshot-based allowance.
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: translationRun,
        tool: { name: 'Write', effect: 'write' },
        input: { path: join(root, 'notes', 'todo.md') },
        permissionPolicy: policy
      })
    ).toBe(true)
    // A path escaping the working directory is denied by the capability policy.
    expect(
      isAuthorizedDesktopRuntimeTool({
        run: translationRun,
        tool: { name: 'Write', effect: 'write' },
        input: { path: '../outside/leak.txt' },
        permissionPolicy: policy
      })
    ).toBe(false)
  })
})
