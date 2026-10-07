import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { decode, encode } from '@msgpack/msgpack'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  root: ''
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => state.root },
  shell: { openPath: vi.fn(async () => '') },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../src/main/lib/ola-data-root', () => ({
  olaExternalDataHome: () => state.root
}))
vi.mock('../../src/main/lib/api-user-agent', () => ({
  getDefaultApiUserAgent: () => 'test-agent'
}))

import { registerSkillsHandlers } from '../../src/main/ipc/skills-handlers'

async function call<T>(channel: string, args?: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ola-skills-ipc-'))
  state.handlers.clear()
  registerSkillsHandlers()
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

it('owns builtin initialization and path resolution in Main TS', async () => {
  await expect(call('skills:ensure-builtins')).resolves.toEqual({ success: true })
  await expect(call('skills:resolve-path', { name: 'missing' })).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('not found')
  })
})

it('serves skill lifecycle, inspection, scan, and cleanup through Main TS', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'ola-skill-source-'))
  const source = join(sourceRoot, 'local-skill')
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: local-skill\ndescription: Use it locally.\n---\n# Local Skill\n',
    'utf8'
  )
  await expect(call('skills:add-from-folder', { sourcePath: source })).resolves.toMatchObject({
    success: true,
    name: 'local-skill'
  })
  await expect(
    call('skills:save', {
      name: 'local-skill',
      content: '---\nname: local-skill\ndescription: Updated locally.\n---\n# Updated\n'
    })
  ).resolves.toEqual({ success: true })
  await expect(call('skills:list')).resolves.toEqual(
    expect.arrayContaining([{ name: 'local-skill', description: 'Updated locally.' }])
  )
  await expect(call('skills:load', { name: 'local-skill' })).resolves.toMatchObject({
    content: '# Updated\n'
  })
  await expect(call('skills:read', { name: 'local-skill' })).resolves.toMatchObject({
    content: expect.stringContaining('# Updated')
  })
  await expect(call('skills:list-files', { name: 'local-skill' })).resolves.toMatchObject({
    files: expect.arrayContaining([expect.objectContaining({ name: 'SKILL.md' })])
  })

  const importedRoot = await mkdtemp(join(tmpdir(), 'ola-skill-import-'))
  const imported = join(importedRoot, 'imported')
  await mkdir(imported, { recursive: true })
  try {
    await writeFile(
      join(imported, 'SKILL.md'),
      '---\nname: imported\ndescription: Imported skill.\n---\n# Imported\n'
    )
    await writeFile(join(imported, 'run.sh'), '#!/bin/sh\nprintf imported')
    await expect(call('skills:scan', { sourcePath: imported })).resolves.toMatchObject({
      name: 'imported',
      files: expect.arrayContaining([expect.objectContaining({ name: 'run.sh' })])
    })
    await expect(call('skills:add-from-folder', { sourcePath: imported })).resolves.toMatchObject({
      success: true,
      name: 'imported'
    })
    const temporaryRoot = join(tmpdir(), 'ola-skills', `download-${Date.now()}`)
    const temporaryPath = join(temporaryRoot, 'imported')
    await mkdir(temporaryPath, { recursive: true })
    await expect(call('skills:cleanup-temp', { tempPath: temporaryPath })).resolves.toEqual({
      success: true
    })
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(importedRoot, { recursive: true, force: true })
  }

  await expect(call('skills:delete', { name: 'local-skill' })).resolves.toEqual({ success: true })
  await expect(call('skills:market-list', { provider: 'other' })).resolves.toEqual({
    total: 0,
    skills: []
  })
  await expect(
    call('skills:download-remote', {
      name: 'remote',
      downloadUrl: 'http://example.invalid/remote.zip'
    })
  ).resolves.toEqual({ error: 'Skill download URL is not an allowed marketplace URL' })
})
