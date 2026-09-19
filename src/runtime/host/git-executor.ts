import { spawn } from 'node:child_process'

export interface GitExecutionResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  errorType?: 'TIMEOUT' | 'SPAWN' | 'OUTPUT_LIMIT'
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export async function executeGit(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number
    maxStdoutChars?: number
    maxStderrChars?: number
    allowTruncatedOutput?: boolean
  } = {}
): Promise<GitExecutionResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 60_000)
  const maxStdoutChars = Math.max(1, options.maxStdoutChars ?? 512 * 1024)
  const maxStderrChars = Math.max(1, options.maxStderrChars ?? 64 * 1024)
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let outputLimited = false
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const append = (current: string, chunk: Buffer, limit: number): string => {
      const next = current + chunk.toString('utf8')
      if (next.length <= limit) return next
      outputLimited = true
      if (!options.allowTruncatedOutput) child.kill()
      return next.slice(0, limit)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk, maxStdoutChars)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk, maxStderrChars)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        success: false,
        stdout,
        stderr: error.message,
        exitCode: -1,
        errorType: 'SPAWN',
        stdoutTruncated: false,
        stderrTruncated: false
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        success:
          !timedOut && (!outputLimited || Boolean(options.allowTruncatedOutput)) && code === 0,
        stdout,
        stderr,
        exitCode: code ?? -1,
        ...(timedOut
          ? { errorType: 'TIMEOUT' as const }
          : outputLimited && !options.allowTruncatedOutput
            ? { errorType: 'OUTPUT_LIMIT' as const }
            : {}),
        stdoutTruncated: stdout.length >= maxStdoutChars,
        stderrTruncated: stderr.length >= maxStderrChars
      })
    })
  })
}
