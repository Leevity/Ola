import { posix } from 'node:path'

function normalizedAbsolute(value: string): string {
  if (!value || !posix.isAbsolute(value) || value.includes('\0'))
    throw new Error('SSH_SCENARIO_PATH_FORBIDDEN')
  return posix.normalize(value).replace(/\/+$/, '') || '/'
}

function isWithinRoot(root: string, candidate: string): boolean {
  return root === '/' || candidate === root || candidate.startsWith(`${root}/`)
}

/** Resolve through SFTP realpath so an in-tree symlink cannot leave the selected remote root. */
export async function resolveSshScenarioPath(
  realpath: (path: string) => Promise<string>,
  root: string,
  requested: string
): Promise<string> {
  if (!requested || requested.includes('\0')) throw new Error('SSH_SCENARIO_PATH_FORBIDDEN')
  const configuredRoot = normalizedAbsolute(root)
  const canonicalRoot = normalizedAbsolute(await realpath(root))
  const candidate = posix.isAbsolute(requested)
    ? requested
    : posix.resolve(canonicalRoot, requested)
  const lexicalCandidate = normalizedAbsolute(candidate)
  if (
    !isWithinRoot(canonicalRoot, lexicalCandidate) &&
    !isWithinRoot(configuredRoot, lexicalCandidate)
  )
    throw new Error('SSH_SCENARIO_PATH_FORBIDDEN')
  const canonicalCandidate = normalizedAbsolute(await realpath(candidate))
  if (!isWithinRoot(canonicalRoot, canonicalCandidate))
    throw new Error('SSH_SCENARIO_PATH_FORBIDDEN')
  return canonicalCandidate
}
