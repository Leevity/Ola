import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../../scripts/prepare-release-notes.mjs', import.meta.url))
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(notes = '# Ola 1.0.6\nVerified changes.\n'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ola-release-notes-'))
  directories.push(path)
  await mkdir(join(path, 'docs/releases'), { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify({ version: '1.0.6' }))
  await writeFile(join(path, 'docs/releases/1.0.6.md'), notes)
  return path
}

function prepare(cwd: string, version: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, INPUT_VERSION: version, INPUT_UNSIGNED_BUILD: 'true' },
    encoding: 'utf8'
  })
}

it('uses version-specific notes and discloses unsigned distribution', async () => {
  const path = await fixture()
  expect(prepare(path, '1.0.6').status).toBe(0)
  const body = await readFile(join(path, 'release-notes.md'), 'utf8')
  expect(body).toContain('Verified changes.')
  expect(body).toContain('无发布证书签名')
  expect(body).toContain('未经 Apple 公证')
})

it('rejects a version that differs from the source manifest', async () => {
  const result = prepare(await fixture(), '1.0.7')
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('must match source version')
})

it('rejects a version containing a path', async () => {
  const result = prepare(await fixture(), '../1.0.6')
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('Invalid release version')
})

it('rejects empty release notes instead of uploading a placeholder', async () => {
  const result = prepare(await fixture('  \n'), '1.0.6')
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('must not be empty')
})
