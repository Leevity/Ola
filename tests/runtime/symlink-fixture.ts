import { stat, symlink } from 'node:fs/promises'

export async function tryCreateTestSymlink(
  target: string,
  path: string,
  requestedType?: 'file' | 'dir'
): Promise<boolean> {
  let type: 'file' | 'dir' | 'junction' | undefined = requestedType
  if (process.platform === 'win32' && (!type || type === 'dir')) {
    try {
      if ((await stat(target)).isDirectory()) type = 'junction'
    } catch {
      // Let symlink report the authoritative path error below.
    }
  }
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return false
    throw error
  }
}

export function skipWhenSymlinkUnavailable(
  context: { skip: (message?: string) => never },
  created: boolean
): void {
  if (!created) context.skip('This Windows environment does not permit creating symbolic links')
}
