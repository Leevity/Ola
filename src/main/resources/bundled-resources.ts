import { app } from 'electron'
import * as path from 'node:path'

/** Returns unpacked resource locations in the same order used by the legacy Worker. */
export function getBundledResourceDirCandidates(name: string): string[] {
  if (!app?.isPackaged) {
    const appPath = path.join(app?.getAppPath?.() ?? process.cwd(), 'resources', name)
    const workingDirectoryPath = path.join(process.cwd(), 'resources', name)
    return appPath === workingDirectoryPath ? [appPath] : [appPath, workingDirectoryPath]
  }

  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', name),
    path.join(process.resourcesPath, 'resources', name)
  ]
}
