import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { dirname, join, sep } from 'node:path'

vi.mock('electron', () => ({ app: {}, session: {} }))
vi.mock('../../src/main/ipc/settings-handlers', () => ({ readSettings: () => ({}) }))

import { listDetectedBrowserProfiles } from '../../src/main/browser/browser-emulation'

const originalRoot = process.env.OLA_E2E_DATA_ROOT
const originalLocalAppData = process.env.LOCALAPPDATA
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalRoot
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('discovers only simulated-home browser profiles during isolated E2E runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-browser-isolated-profile-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const isolatedRoot = join(directory, 'isolated')
  const unrelatedLocalAppData = join(directory, 'host-local-app-data')
  await mkdir(isolatedRoot)
  await writeFile(join(isolatedRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  const browserDataRoot =
    platform() === 'darwin'
      ? join(isolatedRoot, 'Library/Application Support/Google/Chrome')
      : platform() === 'win32'
        ? join(isolatedRoot, 'AppData/Local/Google/Chrome/User Data')
        : join(isolatedRoot, '.config/google-chrome')
  const profile = join(browserDataRoot, 'Default')
  await mkdir(join(profile, 'Network'), { recursive: true })
  await writeFile(join(profile, 'Network', 'Cookies'), '')
  await mkdir(join(unrelatedLocalAppData, 'Google/Chrome/User Data/Default/Network'), {
    recursive: true
  })
  await writeFile(
    join(unrelatedLocalAppData, 'Google/Chrome/User Data/Default/Network/Cookies'),
    ''
  )
  if (platform() !== 'win32') {
    const escapedDataRoot =
      platform() === 'darwin'
        ? join(isolatedRoot, 'Library/Application Support/Microsoft Edge')
        : join(isolatedRoot, '.config/microsoft-edge')
    const externalProfile = join(directory, 'external-edge', 'Default', 'Network')
    await mkdir(externalProfile, { recursive: true })
    await writeFile(join(externalProfile, 'Cookies'), '')
    await mkdir(dirname(escapedDataRoot), { recursive: true })
    await symlink(join(directory, 'external-edge'), escapedDataRoot, 'dir')
  }
  process.env.OLA_E2E_DATA_ROOT = isolatedRoot
  process.env.LOCALAPPDATA = unrelatedLocalAppData

  const profiles = listDetectedBrowserProfiles()
  expect(profiles).toEqual([
    expect.objectContaining({
      browserId: 'chrome',
      dataRoot: browserDataRoot,
      profilePath: profile
    })
  ])
  expect(
    profiles.every((candidate) => candidate.profilePath.startsWith(`${isolatedRoot}${sep}`))
  ).toBe(true)
})
