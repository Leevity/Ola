import { describe, expect, it } from 'vitest'
import type { ProviderConfig, UnifiedMessage } from '../../src/renderer/src/lib/api/types'
import { assessTsRuntimeAgentEligibility } from '../../src/renderer/src/lib/ipc/ts-runtime-agent-eligibility'
import { TS_RUNTIME_CHANNEL_TOOL_NAMES } from '../../src/renderer/src/lib/ipc/ts-runtime-text-eligibility'

const provider: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'secret',
  providerId: 'provider',
  model: 'model'
}
const messages: UnifiedMessage[] = [
  { id: 'user', role: 'user', content: 'Inspect and update this project.', createdAt: 1 }
]
const baseline = {
  mode: 'execute',
  messages,
  provider,
  modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
  workspaceId: 'local-personal',
  workingDirectory: '/workspace',
  toolNames: ['Read', 'Write', 'Edit', 'Bash'],
  hasPlan: false,
  hasGoal: false,
  hasSsh: false,
  hasPlugin: false,
  hasChannels: false,
  hasMcp: false,
  hasTeam: false,
  hasImages: false
} as const

describe('TS runtime Execute eligibility', () => {
  it('projects the compatible execution request without provider secrets', () => {
    expect(assessTsRuntimeAgentEligibility(baseline)).toEqual({
      eligible: true,
      modelSource: baseline.modelSource,
      prompt: 'Inspect and update this project.',
      promptImages: [],
      history: [],
      modelOptions: {}
    })
  })

  it.each([
    [{ hasSsh: true }, 'SSH_NOT_MIGRATED'],
    [{ hasPlugin: true }, 'PLUGIN_NOT_MIGRATED'],
    [{ hasChannels: true }, 'CHANNELS_NOT_MIGRATED'],
    [{ toolNames: ['UnknownTool'] }, 'TOOLS_NOT_MIGRATED'],
    [{ workingDirectory: null }, 'TOOLS_NOT_MIGRATED'],
    [{ mode: 'acp' }, 'MODE_NOT_MIGRATED']
  ] as const)('keeps unsupported Execute capabilities on sidecar: %s', (patch, reason) => {
    expect(assessTsRuntimeAgentEligibility({ ...baseline, ...patch })).toEqual({
      eligible: false,
      reason
    })
  })

  it('keeps Plan Mode on the TS runtime when its tools are Main-owned', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        hasPlan: true,
        toolNames: [
          'Read',
          'Write',
          'Edit',
          'EnterPlanMode',
          'ExitPlanMode',
          'AskUserQuestion',
          'TaskCreate',
          'TaskGet',
          'TaskUpdate',
          'TaskList',
          'Task',
          'Skill',
          'Agent',
          'get_goal',
          'create_goal',
          'update_goal',
          'visualize_show_widget'
        ]
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows the Main-owned team runtime when the team tools are explicitly selected', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        hasTeam: true,
        toolNames: ['Read', 'TeamStatus', 'SendMessage', 'TeamCreate', 'TeamDelete']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows Main-owned image generation through the TS runtime', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: ['Read', 'ImageGenerate']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows workspace-scoped notebook edits only when a working directory is present', () => {
    expect(
      assessTsRuntimeAgentEligibility({ ...baseline, toolNames: ['NotebookEdit'] })
    ).toMatchObject({ eligible: true })
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        workingDirectory: null,
        toolNames: ['NotebookEdit']
      })
    ).toEqual({ eligible: false, reason: 'TOOLS_NOT_MIGRATED' })
  })

  it('allows the Main-owned memory tools after their bounded read-only migration', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: ['Read', 'MemoryList', 'MemoryRead', 'MemorySearch']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows Browser tools through the persisted UI interaction bridge', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: [
          'BrowserNavigate',
          'BrowserGetContent',
          'BrowserScreenshot',
          'BrowserSnapshot',
          'BrowserClick',
          'BrowserType',
          'BrowserScroll'
        ]
      })
    ).toMatchObject({ eligible: true })
  })

  it('accepts the full captured code-session tool snapshot with a trailing system reminder', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        messages: [
          ...messages,
          {
            id: 'memory-reminder',
            role: 'system',
            content: '<system-reminder>[global-memory-update]</system-reminder>',
            createdAt: 2
          }
        ],
        toolNames: [
          'MemoryRead',
          'Read',
          'Grep',
          'Glob',
          'LS',
          'PowerShell',
          'Bash',
          'AskUserQuestion',
          'BrowserClick',
          'BrowserGetContent',
          'BrowserNavigate',
          'BrowserScreenshot',
          'BrowserScroll',
          'BrowserSnapshot',
          'BrowserType',
          'create_goal',
          'CronAdd',
          'CronCreate',
          'CronDelete',
          'CronList',
          'CronRemove',
          'CronUpdate',
          'Edit',
          'EnterPlanMode',
          'ExitPlanMode',
          'get_goal',
          'MemoryList',
          'MemorySearch',
          'Monitor',
          'NotebookEdit',
          'Notify',
          'Skill',
          'Task',
          'TaskCreate',
          'TaskGet',
          'TaskList',
          'TaskUpdate',
          'update_goal',
          'visualize_show_widget',
          'Write'
        ]
      })
    ).toMatchObject({
      eligible: true,
      prompt: 'Inspect and update this project.',
      history: [
        {
          role: 'system',
          text: '<system-reminder>[global-memory-update]</system-reminder>'
        }
      ]
    })
  })

  it('allows Main-owned PowerShell and Monitor only with a workspace root', () => {
    expect(
      assessTsRuntimeAgentEligibility({ ...baseline, toolNames: ['PowerShell', 'Monitor'] })
    ).toMatchObject({ eligible: true })
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        workingDirectory: null,
        toolNames: ['PowerShell', 'Monitor']
      })
    ).toEqual({ eligible: false, reason: 'TOOLS_NOT_MIGRATED' })
  })

  it('allows an explicitly named Main-owned MCP tool through the TS runtime', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: ['Read', 'mcp__docs__search']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows a workspace-bound SSH run when the remote connection is explicit', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        hasSsh: true,
        sshConnectionId: 'connection-a',
        toolNames: ['Read', 'Bash']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows SSH Plan Mode when the remote connection is explicit', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        hasSsh: true,
        sshConnectionId: 'connection-a',
        toolNames: ['Read', 'Write', 'EnterPlanMode', 'ExitPlanMode', 'Bash']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows only an explicit declarative extension tool snapshot', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: ['extension__weather__lookup'],
        extensionToolNames: ['extension__weather__lookup']
      })
    ).toMatchObject({ eligible: true })
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: ['extension__weather__script'],
        extensionToolNames: ['extension__weather__lookup']
      })
    ).toEqual({ eligible: false, reason: 'TOOLS_NOT_MIGRATED' })
  })

  it('allows migrated goal tools when a session already has a goal', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        hasGoal: true,
        toolNames: ['get_goal', 'update_goal']
      })
    ).toMatchObject({ eligible: true })
  })

  it('allows a text-only channel turn when delivery stays outside the model tool set', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        workingDirectory: undefined,
        toolNames: [],
        hasPlugin: false,
        hasChannels: false
      })
    ).toMatchObject({ eligible: true, prompt: 'Inspect and update this project.' })
  })

  it('allows channel tools only with an explicit bound channel context', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        workingDirectory: undefined,
        toolNames: ['PluginGetCurrentChatMessages', 'PluginReplyMessage'],
        hasPlugin: true,
        hasChannels: true,
        channelContext: { pluginId: 'feishu', chatId: 'chat-1', messageId: 'message-1' }
      })
    ).toMatchObject({ eligible: true })
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        workingDirectory: undefined,
        toolNames: ['PluginGetCurrentChatMessages'],
        hasPlugin: true,
        hasChannels: true
      })
    ).toEqual({ eligible: false, reason: 'PLUGIN_NOT_MIGRATED' })
  })

  it('keeps the complete Main-owned channel tool snapshot on the TS path', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        workingDirectory: undefined,
        toolNames: [...TS_RUNTIME_CHANNEL_TOOL_NAMES],
        hasPlugin: true,
        hasChannels: true,
        channelContext: { pluginId: 'feishu', chatId: 'chat-1', messageId: 'message-1' }
      })
    ).toMatchObject({ eligible: true })
  })

  it('keeps malformed or non-MCP external tool names on the sidecar path', () => {
    expect(
      assessTsRuntimeAgentEligibility({ ...baseline, toolNames: ['mcp__docs__not safe'] })
    ).toEqual({ eligible: false, reason: 'TOOLS_NOT_MIGRATED' })
  })

  it('rejects a managed source from another workspace', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        modelSource: { kind: 'ola-team', workspaceId: 'team-a', resourceId: 'resource-a' }
      })
    ).toEqual({ eligible: false, reason: 'WORKSPACE_MISMATCH' })
  })
})
