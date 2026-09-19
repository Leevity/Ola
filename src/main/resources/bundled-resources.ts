import { app } from 'electron'
import * as path from 'node:path'

/** Returns unpacked resource locations in the same order used by the legacy Worker. */
export function getBundledResourceDirCandidates(name: string): string[] {
  if (!app.isPackaged) {
    return [path.join(app.getAppPath(), 'resources', name)]
  }

  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', name),
    path.join(process.resourcesPath, 'resources', name)
  ]
}
