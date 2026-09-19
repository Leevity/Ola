import { describe, expect, it } from 'vitest'
import { executeLocalShell } from '../../src/main/shell/local-shell-executor'

describe('executeLocalShell', () => {
  it('streams output and reports exit status', async () => {
    const events: string[] = []
    const result = await executeLocalShell({
      command:
        process.platform === 'win32' ? 'echo out & echo err 1>&2' : 'printf out; printf err >&2',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {},
      onOutput: (chunk, stream) => events.push(`${stream}:${chunk}`)
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err', timedOut: false })
    expect(events.join('')).toContain('stdout:out')
    expect(events.join('')).toContain('stderr:err')
  })

  it('terminates a command at its timeout', async () => {
    const result = await executeLocalShell({
      command: process.platform === 'win32' ? 'timeout /t 3 >nul' : 'sleep 3',
      cwd: process.cwd(),
      timeoutMs: 50,
      env: {}
    })
    expect(result.timedOut).toBe(true)
  })

  it('publishes a process id and supports explicit cancellation', async () => {
    let processId = ''
    let cancel: (() => void) | undefined
    const result = await executeLocalShell({
      command: process.platform === 'win32' ? 'timeout /t 3 >nul' : 'sleep 3',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {},
      onStarted: (value) => {
        processId = value
      },
      registerAbort: (abort) => {
        cancel = abort
        abort()
      }
    })
    expect(processId).not.toBe('')
    expect(cancel).toBeTypeOf('function')
    expect(result.aborted).toBe(true)
  })

  it('honors a runtime abort signal without a host-specific cancellation callback', async () => {
    const controller = new AbortController()
    const result = await executeLocalShell({
      command: process.platform === 'win32' ? 'timeout /t 3 >nul' : 'sleep 3',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {},
      signal: controller.signal,
      onStarted: () => controller.abort()
    })
    expect(result.aborted).toBe(true)
  })
})
