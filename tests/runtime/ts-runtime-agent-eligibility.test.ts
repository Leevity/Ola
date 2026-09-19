import { describe, expect, it } from 'vitest'
import type { ProviderConfig, UnifiedMessage } from '../../src/renderer/src/lib/api/types'
import { assessTsRuntimeAgentEligibility } from '../../src/renderer/src/lib/ipc/ts-runtime-agent-eligibility'

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
      history: [],
      modelOptions: {}
    })
  })

  it.each([
    [{ hasPlan: true }, 'PLAN_NOT_MIGRATED'],
    [{ hasGoal: true }, 'GOAL_NOT_MIGRATED'],
    [{ hasSsh: true }, 'SSH_NOT_MIGRATED'],
    [{ hasPlugin: true }, 'PLUGIN_NOT_MIGRATED'],
    [{ hasChannels: true }, 'CHANNELS_NOT_MIGRATED'],
    [{ hasTeam: true }, 'TEAM_NOT_MIGRATED'],
    [{ hasImages: true }, 'ATTACHMENTS_NOT_MIGRATED'],
    [{ toolNames: ['BrowserNavigate'] }, 'TOOLS_NOT_MIGRATED'],
    [{ workingDirectory: null }, 'TOOLS_NOT_MIGRATED'],
    [{ mode: 'acp' }, 'MODE_NOT_MIGRATED']
  ] as const)('keeps unsupported Execute capabilities on sidecar: %s', (patch, reason) => {
    expect(assessTsRuntimeAgentEligibility({ ...baseline, ...patch })).toEqual({
      eligible: false,
      reason
    })
  })

  it('allows an explicitly named Main-owned MCP tool through the TS runtime', () => {
    expect(
      assessTsRuntimeAgentEligibility({
        ...baseline,
        toolNames: ['Read', 'mcp__docs__search']
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
