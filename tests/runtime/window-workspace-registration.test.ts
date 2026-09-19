import { beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({ ipcClient: { invoke } }))

beforeEach(() => {
  invoke.mockReset()
  vi.resetModules()
})

it('shares an in-flight registration and waits for the Main acknowledgement', async () => {
  let release: ((value: unknown) => void) | undefined
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const { ensureWindowWorkspaceRegistered } =
    await import('../../src/renderer/src/lib/window-workspace-registration')
  const first = ensureWindowWorkspaceRegistered('team-a')
  const second = ensureWindowWorkspaceRegistered('team-a')
  expect(invoke).toHaveBeenCalledOnce()
  release?.({ workspaceId: 'team-a' })
  await Promise.all([first, second])
  await ensureWindowWorkspaceRegistered('team-a')
  expect(invoke).toHaveBeenCalledOnce()
})

it('invalidates a stale acknowledgement when the workspace directory changes', async () => {
  let releaseOld: ((value: unknown) => void) | undefined
  invoke
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve
        })
    )
    .mockResolvedValue({ workspaceId: 'team-a' })
  const { ensureWindowWorkspaceRegistered, invalidateWindowWorkspaceRegistration } =
    await import('../../src/renderer/src/lib/window-workspace-registration')
  const old = ensureWindowWorkspaceRegistered('team-a')
  invalidateWindowWorkspaceRegistration()
  await ensureWindowWorkspaceRegistered('team-a')
  releaseOld?.({ workspaceId: 'team-a' })
  await old
  expect(invoke).toHaveBeenCalledTimes(2)
  await ensureWindowWorkspaceRegistered('team-a')
  expect(invoke).toHaveBeenCalledTimes(2)
})
