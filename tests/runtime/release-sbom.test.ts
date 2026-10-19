import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReleaseSbom,
  findPackagedArchive,
  readPackagedInventory
} from '../../scripts/release-sbom.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')
const temporary: string[] = []
async function fixture(manifests: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ola-release-sbom-'))
  temporary.push(root)
  const source = join(root, 'source')
  for (const [name, data] of Object.entries(manifests)) {
    const file = join(source, name)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(data))
  }
  const archive = join(root, 'app.asar')
  await asar.createPackage(source, archive)
  return archive
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const app = { name: 'ola', version: '1.0.6' }

describe('packaged release dependency inventory', () => {
  it('uses installed names and versions, retaining nested copies and excluding fixture manifests', async () => {
    const archive = await fixture({
      'package.json': app,
      'node_modules/direct/package.json': { name: 'actual-installed-name', version: '2.0.1' },
      'node_modules/direct/node_modules/@scope/nested/package.json': {
        name: '@scope/nested',
        version: '3.1.0'
      },
      'node_modules/@scope/nested/package.json': { name: '@scope/nested', version: '4.2.0' },
      'node_modules/direct/test/fixture/package.json': {
        name: 'not-an-installed-dependency',
        version: '9.9.9'
      }
    })
    const inventory = readPackagedInventory(archive)
    expect(inventory.manifest).toEqual(app)
    expect(inventory.components.map((item) => `${item.name}@${item.versionInfo}`).sort()).toEqual([
      '@scope/nested@3.1.0',
      '@scope/nested@4.2.0',
      'actual-installed-name@2.0.1'
    ])
  })
  it('rejects malformed installed metadata instead of silently omitting it', async () => {
    const archive = await fixture({
      'package.json': app,
      'node_modules/bad/package.json': { name: 'bad' }
    })
    expect(() => readPackagedInventory(archive)).toThrow('lacks name/version')
  })
  it('includes dependency manifests from the platform unpacked directory', async () => {
    const archive = await fixture({ 'package.json': app })
    const unpacked = `${archive}.unpacked/node_modules/native/package.json`
    await mkdir(join(unpacked, '..'), { recursive: true })
    await writeFile(unpacked, JSON.stringify({ name: 'native', version: '5.0.0' }))
    const inventory = readPackagedInventory(archive)
    expect(inventory.components).toEqual([
      {
        name: 'native',
        versionInfo: '5.0.0',
        path: 'app.asar.unpacked/node_modules/native/package.json'
      }
    ])
  })
  it('rejects a non-string packaged application version', async () => {
    const archive = await fixture({ 'package.json': { name: 'ola', version: 106 } })
    expect(() => readPackagedInventory(archive)).toThrow('lacks name/version')
  })
  it('rejects missing installed dependency inventory', async () => {
    const archive = await fixture({ 'package.json': app })
    expect(() => readPackagedInventory(archive)).toThrow('No installed dependency manifests')
  })
  it('requires an unambiguous archive rather than picking a different app or architecture', async () => {
    const archive = await fixture({ 'package.json': app })
    const directory = join(archive, '..')
    expect(findPackagedArchive(directory)).toBe(archive)
    await writeFile(join(directory, 'other.asar'), 'not selected')
    await mkdir(join(directory, 'second'))
    await writeFile(join(directory, 'second', 'app.asar'), 'ambiguous')
    expect(() => findPackagedArchive(directory)).toThrow('found 2')
  })
  it('fails if no archive exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-release-sbom-empty-'))
    temporary.push(root)
    expect(() => findPackagedArchive(root)).toThrow('found 0')
  })
  it('emits only valid hex artifact checksums and resolvable SPDX relationships', () => {
    const document = createReleaseSbom(
      app,
      [{ name: 'ssh2', versionInfo: '1.0.0', path: 'node_modules/ssh2/package.json' }],
      [{ name: 'Ola.zip', sha256: 'a'.repeat(64) }],
      '2026-10-17T00:00:00.000Z'
    )
    expect(document.packages).toHaveLength(2)
    expect(document.packages[1]).not.toHaveProperty('checksums')
    expect(document.files[0].checksums[0]).toEqual({
      algorithm: 'SHA256',
      checksumValue: 'a'.repeat(64)
    })
    const ids = new Set([
      document.SPDXID,
      ...document.packages.map((entry) => entry.SPDXID),
      ...document.files.map((entry) => entry.SPDXID)
    ])
    for (const relation of document.relationships) {
      expect(ids.has(relation.spdxElementId)).toBe(true)
      expect(ids.has(relation.relatedSpdxElement)).toBe(true)
    }
    expect(document.comment).toContain('does not claim complete binary composition')
  })
  it('rejects base64 or truncated artifact checksum values', () => {
    expect(() =>
      createReleaseSbom(app, [], [{ name: 'Ola.zip', sha256: 'not-a-hex-sha256==' }])
    ).toThrow('Invalid artifact SHA256')
  })
})
