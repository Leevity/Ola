import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { olaDataRoot, olaExternalDataHome } from '../../src/main/lib/ola-data-root'
import { configureIsolatedElectronUserData } from '../../src/main/lib/isolated-electron-user-data'
import { sshWorkspaceConfigPath } from '../../src/main/ssh/ssh-workspace-path'
import { loadOpenSshKnownHosts } from '../../src/main/ssh/ssh-import-openssh'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const originalOverride = process.env.OLA_E2E_DATA_ROOT
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  if (originalOverride === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalOverride
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('keeps the existing Ola data directory until every Main and Native path is migrated', () => {
  delete process.env.OLA_E2E_DATA_ROOT
  expect(olaDataRoot()).toBe(join(homedir(), '.ola'))
  expect(olaExternalDataHome()).toBe(homedir())
  const setPath = vi.fn()
  configureIsolatedElectronUserData({ setPath })
  expect(setPath).not.toHaveBeenCalled()
})

it('requires an existing marked, absolute directory and never falls back on invalid overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-e2e-root-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  process.env.OLA_E2E_DATA_ROOT = 'relative-test-root'
  expect(() => olaDataRoot()).toThrow('absolute, marked test directory')
  process.env.OLA_E2E_DATA_ROOT = directory
  expect(() => olaDataRoot()).toThrow()
  const setPath = vi.fn()
  expect(() => configureIsolatedElectronUserData({ setPath })).toThrow()
  expect(setPath).not.toHaveBeenCalled()
  await writeFile(join(directory, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  expect(olaDataRoot()).toBe(resolve(directory))
  configureIsolatedElectronUserData({ setPath })
  expect(setPath).toHaveBeenCalledWith('userData', join(directory, 'electron-user-data'))
  expect(existsSync(join(directory, 'electron-user-data'))).toBe(true)
  expect(olaExternalDataHome()).toBe(resolve(directory))
  expect(sshWorkspaceConfigPath(olaExternalDataHome(), 'local-personal', olaDataRoot())).toBe(
    join(directory, '.ola.json')
  )
  process.env.OLA_E2E_DATA_ROOT = homedir()
  expect(() => olaDataRoot()).toThrow('cannot be a user or filesystem data root')
})

it('uses the same marked test root in Main and the real Native Worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-e2e-root-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  process.env.OLA_E2E_DATA_ROOT = directory
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
  })
  const result = await client.request('db/initialize', {})
  expect(result).toMatchObject({ success: true, dbPath: join(olaDataRoot(), 'data.db') })
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'ola-e2e-outside-projects-'))
  cleanup.push(() => rm(outsideDirectory, { recursive: true, force: true }))
  const project = await client.request('db/projects-create', {
    name: 'Test project',
    workspaceId: 'local-personal',
    baseDirectory: outsideDirectory
  })
  expect(project.working_folder).toBe(join(directory, 'projects', 'Test project'))
  expect(existsSync(join(outsideDirectory, 'Test project'))).toBe(false)
  const sshDirectory = join(directory, '.ssh')
  await mkdir(sshDirectory, { recursive: true })
  await writeFile(
    join(sshDirectory, 'config'),
    'Host isolated-example\n  HostName example.invalid\n  IdentityFile ~/.ssh/id_test\n'
  )
  await writeFile(join(sshDirectory, 'known_hosts'), 'example.invalid ssh-ed25519 AAAA\n')
  expect(await loadOpenSshKnownHosts(join(sshDirectory, 'config'))).toContain('example.invalid')
  expect(
    await client.request('ssh/config-openssh-host', { alias: 'isolated-example' })
  ).toMatchObject({
    hostName: 'example.invalid',
    identityFile: join(directory, '.ssh', 'id_test')
  })
  if (process.platform !== 'win32') {
    const shell = await client.request('shell/exec', {
      shell: '/bin/sh',
      command: 'pwd -P; printf "%s\\n" "$HOME"',
      env: { HOME: outsideDirectory }
    })
    expect(shell).toMatchObject({ success: true, exitCode: 0 })
    const [shellCwd, shellHome] = String(shell.stdout).trim().split('\n')
    expect(realpathSync(shellCwd)).toBe(realpathSync(directory))
    expect(realpathSync(shellHome)).toBe(realpathSync(directory))
    const terminal = await client.request('terminal/create', {
      shell: '/bin/sh',
      command: 'pwd',
      env: { HOME: outsideDirectory }
    })
    expect(realpathSync(String(terminal.cwd))).toBe(realpathSync(directory))
    if (terminal.id) await client.request('terminal/kill', { id: terminal.id })
  }
  expect(
    await client.request('ssh/config-write-snapshot', { groups: [], connections: [] })
  ).toMatchObject({
    success: true
  })
  expect(existsSync(join(directory, '.ola.json'))).toBe(true)
  const skillDirectory = join(directory, '.agents', 'skills', 'test-skill')
  await mkdir(skillDirectory, { recursive: true })
  expect(await client.request('skills/resolve-path', { name: 'test-skill' })).toMatchObject({
    success: true,
    path: skillDirectory
  })
})

it('rejects an unmarked Worker override instead of creating a database in user data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-e2e-unmarked-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory, undefined, {
    OLA_E2E_DATA_ROOT: directory
  })
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
  })
  expect(await client.request('db/initialize', {})).toMatchObject({
    error: 'OLA_E2E_DATA_ROOT has an invalid test marker'
  })
  expect(existsSync(join(directory, 'data.db'))).toBe(false)
})
