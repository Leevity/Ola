import { describe, expect, it } from 'vitest'
import { canRunCronInTsRuntime } from '../../src/main/cron/ts-cron-selection'

describe('TS cron selection', () => {
  const local = { kind: 'local' as const, providerId: 'local', modelId: 'model' }

  it('only selects the TS engine when every required host capability is represented', () => {
    expect(canRunCronInTsRuntime({ modelSource: local }, true)).toBe(true)
    expect(canRunCronInTsRuntime({ modelSource: local, agentId: 'CustomAgent' }, true)).toBe(false)
    expect(canRunCronInTsRuntime({ modelSource: local, sshConnectionId: 'ssh-1' }, true)).toBe(
      false
    )
    expect(
      canRunCronInTsRuntime({ modelSource: local, pluginId: 'p', pluginChatId: 'c' }, true)
    ).toBe(false)
    expect(canRunCronInTsRuntime({ modelSource: null }, true)).toBe(false)
    expect(canRunCronInTsRuntime({ modelSource: local }, false)).toBe(false)
  })
})
