import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'

const e2eMarker = '.ola-e2e-root'
const e2eMarkerContent = 'OLA_ISOLATED_E2E_ROOT\n'

/** One Main-process definition of the legacy Ola data root. */
export function olaDataRoot(): string {
  const override = process.env.OLA_E2E_DATA_ROOT
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) {
      throw new Error('OLA_E2E_DATA_ROOT must be an absolute, marked test directory')
    }
    const requestedRoot = resolve(override)
    const root = realpathSync(requestedRoot)
    const home = realpathSync(homedir())
    if (root === parse(root).root || root === home || root === resolve(home, '.ola')) {
      throw new Error('OLA_E2E_DATA_ROOT cannot be a user or filesystem data root')
    }
    if (readFileSync(join(root, e2eMarker), 'utf8') !== e2eMarkerContent) {
      throw new Error('OLA_E2E_DATA_ROOT has an invalid test marker')
    }
    return requestedRoot
  }
  return join(homedir(), '.ola')
}

/** Legacy user-home content is redirected only for a validated isolated E2E run. */
export function olaExternalDataHome(): string {
  return process.env.OLA_E2E_DATA_ROOT === undefined ? homedir() : olaDataRoot()
}
