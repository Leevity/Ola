import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { olaDataRoot } from './ola-data-root'

/** Set Electron's profile before readiness; the marked root is validated by olaDataRoot. */
export function configureIsolatedElectronUserData(app: {
  setPath(name: 'userData', path: string): void
}): void {
  if (process.env.OLA_E2E_DATA_ROOT === undefined) return
  const profilePath = join(olaDataRoot(), 'electron-user-data')
  mkdirSync(profilePath, { recursive: true })
  app.setPath('userData', profilePath)
}
