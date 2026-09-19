import { executeGit, type GitExecutionResult } from './git-executor'

/** Reject references that could be parsed as an option or revision expression. */
export function isSafeGitReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('-') &&
    !value.includes('..') &&
    /^[A-Za-z0-9._~^@/:-]+$/.test(value)
  )
}

/** Files are always passed after `--`, but retain a repository-relative boundary. */
export function isSafeGitPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}

export function requireSafeGitReference(value: unknown, label: string): string {
  if (!isSafeGitReference(value)) throw new Error(`Invalid git ${label}`)
  return value
}

export function requireSafeGitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000 || !value.every(isSafeGitPath))
    throw new Error('Invalid git file path')
  return value
}

/** Main-owned local mutation path. Remote Git must use its SSH host adapter. */
export async function executeLocalGitMutation(
  cwd: string,
  args: string[]
): Promise<GitExecutionResult> {
  return await executeGit(cwd, args, {
    timeoutMs: 60_000,
    maxStdoutChars: 2 * 1024 * 1024,
    maxStderrChars: 64 * 1024
  })
}
