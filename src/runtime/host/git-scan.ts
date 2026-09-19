import { readdir } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { executeGit } from './git-executor'

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  'coverage',
  'tmp',
  'cache',
  'obj',
  'bin'
])

export interface LocalGitRepositorySummary {
  name: string
  fullPath: string
  relativePath: string
  branch: string
  isRootRepo: boolean
}

async function isRepository(directory: string): Promise<boolean> {
  const result = await executeGit(directory, ['rev-parse', '--is-inside-work-tree'])
  return result.success && result.stdout.trim() === 'true'
}

async function branch(directory: string): Promise<string> {
  const result = await executeGit(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return result.success ? result.stdout.trim() || 'HEAD' : 'HEAD'
}

/**
 * Scans only local directories and never follows symlinks. This deliberately
 * mirrors the legacy depth/exclusion behavior while leaving remote traversal
 * to the SSH host adapter.
 */
export async function scanLocalGitRepositories(args: {
  rootPath: string
  maxDepth: number
  excludeDirs?: readonly string[]
}): Promise<LocalGitRepositorySummary[]> {
  const root = resolve(args.rootPath)
  const maxDepth = Math.max(0, Math.min(Math.trunc(args.maxDepth), 20))
  const excluded = new Set([
    ...DEFAULT_EXCLUDED_DIRECTORIES,
    ...(args.excludeDirs ?? []).map((value) => value.toLowerCase())
  ])
  const repositories: LocalGitRepositorySummary[] = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]

  while (queue.length) {
    const current = queue.shift()!
    if (await isRepository(current.directory)) {
      const rel = relative(root, current.directory)
      repositories.push({
        name: basename(current.directory),
        fullPath: current.directory,
        relativePath: rel ? rel.split(sep).join('/') : '.',
        branch: await branch(current.directory),
        isRootRepo: !rel
      })
      continue
    }
    if (current.depth >= maxDepth) continue
    try {
      const entries = await readdir(current.directory, { withFileTypes: true })
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          excluded.has(entry.name.toLowerCase())
        )
          continue
        queue.push({ directory: resolve(current.directory, entry.name), depth: current.depth + 1 })
      }
    } catch {
      continue
    }
  }
  return repositories.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}
