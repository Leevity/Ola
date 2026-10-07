import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (args: unknown, event: unknown) => Promise<unknown>>(),
  workspaceId: 'local-personal' as string | null,
  getSession: vi.fn(),
  list: vi.fn(),
  trust: vi.fn(),
  emit: vi.fn()
}))

vi.mock('../../src/main/ipc/messagepack-handler', () => ({
  registerMessagePackHandler: (
    channel: string,
    handler: (args: unknown, event: unknown) => Promise<unknown>
  ) => state.handlers.set(channel, handler)
}))
vi.mock('../../src/main/window-ipc', () => ({
  getTrustedWorkspaceRegistrationWindow: () => ({}),
  getRegisteredWindowWorkspace: () => state.workspaceId
}))
vi.mock('../../src/main/db/sessions-dao', () => ({ getSession: state.getSession }))
vi.mock('../../src/main/hooks/hooks-service', () => ({
  hooksService: {
    list: state.list,
    trust: state.trust,
    revoke: vi.fn(),
    history: vi.fn(),
    cancel: vi.fn(),
    emit: state.emit
  }
}))

import { registerHooksHandlers } from '../../src/main/ipc/hooks-handlers'

beforeEach(() => {
  state.handlers.clear()
  state.workspaceId = 'local-personal'
  state.getSession.mockReset()
  state.list.mockReset()
  state.trust.mockReset()
  state.emit.mockReset()
  registerHooksHandlers()
})

it('blocks hooks for a persisted scenario even when the Renderer has no session state', async () => {
  state.getSession.mockResolvedValue({ scenario_policy: 'materials-no-tools' })
  const invoke = state.handlers.get('hooks:emit')!
  await expect(
    invoke({ event: 'sessionStart', invocation: { sessionId: 'scenario' } }, {})
  ).resolves.toEqual([])
  expect(state.getSession).toHaveBeenCalledWith('scenario', 'local-personal')
  expect(state.emit).not.toHaveBeenCalled()
})

it('preserves ordinary session hooks and requires a registered workspace', async () => {
  state.getSession.mockResolvedValue({ scenario_policy: null })
  state.emit.mockResolvedValue([{ additionalContext: 'ordinary' }])
  const invoke = state.handlers.get('hooks:emit')!
  await expect(
    invoke({ event: 'sessionStart', invocation: { sessionId: 'ordinary' } }, {})
  ).resolves.toEqual([{ additionalContext: 'ordinary' }])
  state.workspaceId = null
  await expect(
    invoke({ event: 'sessionStart', invocation: { sessionId: 'ordinary' } }, {})
  ).rejects.toThrow('WINDOW_WORKSPACE_UNAVAILABLE')
})

it('rejects a hook when its session does not belong to the registered workspace', async () => {
  state.getSession.mockResolvedValue(null)
  const invoke = state.handlers.get('hooks:emit')!
  await expect(
    invoke({ event: 'sessionStart', invocation: { sessionId: 'other-workspace' } }, {})
  ).rejects.toThrow('HOOK_SESSION_WORKSPACE_MISMATCH')
  expect(state.emit).not.toHaveBeenCalled()
})

it('resolves hook paths from the persisted session rather than Renderer input', async () => {
  state.getSession.mockResolvedValue({
    scenario_policy: null,
    working_folder: 'C:/project',
    ssh_connection_id: null
  })
  state.list.mockResolvedValue([])
  state.trust.mockResolvedValue(undefined)
  state.emit.mockResolvedValue([])
  await state.handlers.get('hooks:list')!({ sessionId: 'ordinary', projectPath: 'C:/other' }, {})
  expect(state.list).toHaveBeenCalledWith('C:/project')
  await state.handlers.get('hooks:trust')!(
    { trustKey: 'trusted', sessionId: 'ordinary', projectPath: 'C:/other' },
    {}
  )
  expect(state.trust).toHaveBeenCalledWith('trusted', 'C:/project')
  await state.handlers.get('hooks:emit')!(
    {
      event: 'sessionStart',
      invocation: { sessionId: 'ordinary', projectPath: 'C:/other' }
    },
    {}
  )
  expect(state.emit).toHaveBeenCalledWith('sessionStart', {
    sessionId: 'ordinary',
    projectPath: 'C:/project'
  })
})

it('does not treat an SSH working folder as a local Hook project path', async () => {
  state.getSession.mockResolvedValue({
    scenario_policy: null,
    working_folder: '/srv/project',
    ssh_connection_id: 'ssh-1'
  })
  state.list.mockResolvedValue([])
  await state.handlers.get('hooks:list')!({ sessionId: 'remote' }, {})
  expect(state.list).toHaveBeenCalledWith(undefined)
})
