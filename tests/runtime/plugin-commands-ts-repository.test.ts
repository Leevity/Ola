import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../../src/main/channels/plugin-commands'
import { tryHandleCommand } from '../../src/main/channels/plugin-commands'
import { businessWriteCanary } from '../../src/main/db/business-write-canary'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/tmp' } }))
vi.mock('../../src/main/db/business-write-canary', () => ({ businessWriteCanary: vi.fn() }))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(['local-personal', 'team-a'])
}))
vi.mock('../../src/main/channels/channel-config-store', () => ({
  readChannelPlugins: async () => []
}))

const mockedWriter = vi.mocked(businessWriteCanary)
const sendMessage = vi.fn(async () => undefined)
const writer = {
  clearChannelSession: vi.fn(async () => 3),
  sessionStatus: vi.fn(async () => ({
    success: true,
    found: true,
    title: 'Team chat',
    messageCount: 4
  })),
  compactSessionMessages: vi.fn(async () => ({
    success: true,
    totalMessages: 8,
    compacted: 4
  })),
  sessionUsageStats: vi.fn(async () => ({
    success: true,
    hasUsage: true,
    totalInput: 120,
    totalOutput: 80,
    totalCacheCreation: 0,
    totalCacheRead: 0,
    totalReasoning: 0,
    totalDurationMs: 1000,
    requestCount: 2,
    assistantReplies: 2
  }))
}

function context(content: string): CommandContext {
  return {
    pluginId: 'plugin',
    pluginType: 'discord',
    chatId: 'chat',
    data: { content },
    sessionId: 'session',
    workspaceId: 'team-a',
    pluginWorkDir: '/tmp',
    pluginManager: {
      getService: () => ({ sendMessage }),
      getStatus: () => 'running'
    }
  } as unknown as CommandContext
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedWriter.mockReturnValue(writer as unknown as ReturnType<typeof businessWriteCanary>)
})

describe('channel slash commands use TS business repository', () => {
  it.each([
    ['/new', 'clearChannelSession', 'Session cleared'],
    ['/status', 'sessionStatus', 'Team chat'],
    ['/compress', 'compactSessionMessages', 'Context compressed'],
    ['/stats', 'sessionUsageStats', '200 tokens']
  ] as const)(
    '%s uses TS repository with the authorized workspace',
    async (command, method, text) => {
      expect(await tryHandleCommand(context(command))).toBe(true)
      expect(writer[method]).toHaveBeenCalledWith({ sessionId: 'session', workspaceId: 'team-a' })
      expect(sendMessage).toHaveBeenCalledWith('chat', expect.stringContaining(text))
    }
  )

  it('fails closed when the TS repository is unavailable', async () => {
    mockedWriter.mockReturnValue(null)
    expect(await tryHandleCommand(context('/new'))).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith('chat', expect.stringContaining('Failed to clear'))
    expect(writer.clearChannelSession).not.toHaveBeenCalled()
  })
})
