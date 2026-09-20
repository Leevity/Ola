import { describe, expect, it } from 'vitest'
import { TerminalSessionManager } from '../../src/main/terminal/terminal-session-manager'

function waitFor<T>(
  subscribe: (resolve: (value: T) => void) => () => void,
  timeout = 5_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for terminal event'))
    }, timeout)
    const unsubscribe = subscribe((value) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    })
  })
}

describe('TerminalSessionManager', () => {
  it('runs a local command and preserves output in its snapshot', async () => {
    const manager = new TerminalSessionManager()
    const output = waitFor<{ id: string; data: string; seq: number }>((resolve) =>
      manager.onOutput((event) => event.data.includes('OLA_TERMINAL_MARKER') && resolve(event))
    )
    const created = manager.create({
      workspaceId: 'team-test',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      command:
        process.platform === 'win32'
          ? 'echo OLA_TERMINAL_MARKER && timeout /t 1 >nul'
          : 'printf OLA_TERMINAL_MARKER; sleep 1'
    })
    expect(manager.resize(created.id, 100, 40)).toEqual({ success: true })
    const event = await output
    expect(event.id).toBe(created.id)
    expect(created.workspaceId).toBe('team-test')
    expect(event.seq).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(manager.get(created.id)).toMatchObject({
      id: created.id,
      buffer: [expect.objectContaining({ data: expect.stringContaining('OLA_TERMINAL_MARKER') })]
    })
    manager.killAll()
  })

  it('keeps terminal listings isolated by workspace', () => {
    const manager = new TerminalSessionManager()
    const local = manager.create({ workspaceId: 'local-personal' })
    const team = manager.create({ workspaceId: 'team-test' })
    expect(manager.list('local-personal').map((entry) => entry.id)).toEqual([local.id])
    expect(manager.list('team-test').map((entry) => entry.id)).toEqual([team.id])
    manager.killAll()
  })
})
