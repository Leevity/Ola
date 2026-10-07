import { spawn, type ChildProcess } from 'node:child_process'

export async function executeLocalShell(input: {
  command: string
  cwd: string
  timeoutMs: number
  shell?: string
  env: Record<string, string>
  maxOutputBytes?: number
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  onStarted?: (processId: string) => void
  signal?: AbortSignal
  registerAbort?: (abort: () => void) => void
}): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  outputLimitExceeded: boolean
  shell: string
}> {
  const shell =
    input.shell ||
    (process.platform === 'win32'
      ? process.env.ComSpec || 'cmd.exe'
      : process.env.SHELL || '/bin/sh')
  const isPowerShell =
    process.platform === 'win32' && input.shell?.toLowerCase().endsWith('powershell.exe') === true
  const args = isPowerShell
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', input.command]
    : process.platform === 'win32'
      ? ['/d', '/s', '/c', input.command]
      : ['-lc', input.command]
  return await new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      timedOut = false,
      aborted = false,
      outputLimitExceeded = false,
      outputBytes = 0,
      child: ChildProcess
    try {
      child = spawn(shell, args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        shell: false,
        windowsHide: true
      })
    } catch (error) {
      resolve({
        exitCode: 1,
        stdout,
        stderr: String(error),
        timedOut,
        aborted,
        outputLimitExceeded,
        shell
      })
      return
    }
    const abort = () => {
      aborted = true
      child.kill()
    }
    input.registerAbort?.(abort)
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    input.onStarted?.(String(child.pid ?? ''))
    const timer = setTimeout(
      () => {
        timedOut = true
        child.kill()
      },
      Math.max(1, input.timeoutMs)
    )
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const value = chunk.toString()
      outputBytes += chunk.byteLength
      if (input.maxOutputBytes && outputBytes > input.maxOutputBytes) {
        outputLimitExceeded = true
        child.kill()
        return
      }
      if (stream === 'stdout') stdout += value
      else stderr += value
      input.onOutput?.(value, stream)
    }
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
    child.on('error', (error) => {
      stderr += error.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        aborted,
        outputLimitExceeded,
        shell
      })
    })
  })
}
