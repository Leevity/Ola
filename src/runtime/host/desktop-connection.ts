import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface RuntimeConnectionDescriptor {
  endpoint: string
  token: string
}

function valid(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

export function desktopRuntimeDescriptorPath(baseDirectory = join(homedir(), '.ola')): string {
  return join(baseDirectory, 'runtime-private', 'desktop-runtime.json')
}

/**
 * Publish the desktop-owned local socket only to the current OS user. The
 * descriptor contains a bearer token, so a permissive file is treated as
 * unavailable instead of being trusted by the CLI.
 */
export async function publishDesktopRuntimeConnection(
  descriptor: RuntimeConnectionDescriptor,
  path = desktopRuntimeDescriptorPath()
): Promise<void> {
  if (!valid(descriptor.endpoint, 4096) || !valid(descriptor.token, 512))
    throw new Error('Invalid desktop runtime descriptor')
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0)
  )
    throw new Error('DESKTOP_RUNTIME_DESCRIPTOR_DIRECTORY_UNSAFE')
  const temporary = join(directory, `.desktop-runtime-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export async function readDesktopRuntimeConnection(
  path = desktopRuntimeDescriptorPath()
): Promise<RuntimeConnectionDescriptor | null> {
  try {
    const fileStat = await lstat(path)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null
    if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) return null
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (!valid(item.endpoint, 4096) || !valid(item.token, 512)) return null
    return { endpoint: item.endpoint, token: item.token }
  } catch {
    return null
  }
}

/** Never remove a descriptor published by another running desktop instance. */
export async function clearDesktopRuntimeConnection(
  token: string,
  path = desktopRuntimeDescriptorPath()
): Promise<void> {
  const current = await readDesktopRuntimeConnection(path)
  if (current?.token === token) await unlink(path).catch(() => undefined)
}
