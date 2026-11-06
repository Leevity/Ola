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
import { bundledBinaryComponents } from '../../scripts/agent-desktop-sbom.mjs'

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
      [],
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
  it('registers bundled native binaries as their own SPDX package', () => {
    const document = createReleaseSbom(
      app,
      [{ name: 'ssh2', versionInfo: '1.0.0', path: 'node_modules/ssh2/package.json' }],
      [{ name: 'Ola.zip', sha256: 'a'.repeat(64) }],
      [
        {
          name: 'agent-desktop',
          versionInfo: '1.1.0',
          licenseDeclared: 'Apache-2.0',
          downloadLocation: 'https://github.com/vercel-labs/agent-desktop/releases/download/v1.1.0',
          source: 'resources/agent-desktop.lock.json',
          repository: 'https://github.com/vercel-labs/agent-desktop',
          checksumsFile: 'https://example.invalid/checksums.txt',
          checksumsSha256: 'b'.repeat(64),
          files: [
            {
              fileName: './resources/agent-desktop/darwin-arm64/agent-desktop',
              sha256: 'c'.repeat(64),
              size: 3757904
            }
          ]
        }
      ]
    )
    const bundled = document.packages.find((entry) => entry.SPDXID === 'SPDXRef-Bundled-1')
    expect(bundled).toMatchObject({
      name: 'agent-desktop',
      versionInfo: '1.1.0',
      licenseDeclared: 'Apache-2.0',
      licenseConcluded: 'Apache-2.0',
      filesAnalyzed: true
    })
    expect(bundled.downloadLocation).toMatch(/^https:\/\//)
    expect(bundled.comment).toContain('resources/agent-desktop.lock.json')
    const file = document.files.find((entry) => entry.SPDXID === 'SPDXRef-BundledFile-1-1')
    expect(file).toMatchObject({
      fileName: './resources/agent-desktop/darwin-arm64/agent-desktop',
      licenseConcluded: 'Apache-2.0',
      checksums: [{ algorithm: 'SHA256', checksumValue: 'c'.repeat(64) }]
    })
    // A package the document cannot account for would make the SBOM unreadable downstream.
    const ids = new Set([
      document.SPDXID,
      ...document.packages.map((entry) => entry.SPDXID),
      ...document.files.map((entry) => entry.SPDXID)
    ])
    for (const relation of document.relationships) {
      expect(ids.has(relation.spdxElementId)).toBe(true)
      expect(ids.has(relation.relatedSpdxElement)).toBe(true)
      expect(relation).not.toHaveProperty('comment')
    }
    expect(
      document.relationships.filter(
        (relation) => relation.relatedSpdxElement === 'SPDXRef-Bundled-1'
      )
    ).toHaveLength(1)
    expect(
      document.relationships.filter((relation) => relation.spdxElementId === 'SPDXRef-Bundled-1')
    ).toHaveLength(1)
  })
  it('refuses an unlicensed, unversioned or non-https bundled component', () => {
    const base = {
      name: 'agent-desktop',
      versionInfo: '1.1.0',
      licenseDeclared: 'Apache-2.0',
      downloadLocation: 'https://example.invalid/releases',
      source: 'resources/agent-desktop.lock.json',
      repository: 'https://example.invalid',
      checksumsFile: 'https://example.invalid/checksums.txt',
      checksumsSha256: 'b'.repeat(64),
      files: [{ fileName: './a', sha256: 'c'.repeat(64), size: 1 }]
    }
    expect(() => createReleaseSbom(app, [], [], [{ ...base, licenseDeclared: '' }])).toThrow(
      'lacks name/version/license'
    )
    expect(() =>
      createReleaseSbom(app, [], [], [{ ...base, downloadLocation: 'http://x' }])
    ).toThrow('https source URL')
    expect(() =>
      createReleaseSbom(app, [], [], [{ ...base, files: [{ ...base.files[0], sha256: 'zz' }] }])
    ).toThrow('Invalid bundled binary SHA256')
    expect(() => createReleaseSbom(app, [], [], [{ ...base, versionInfo: '' }])).toThrow(
      'lacks name/version/license'
    )
  })
  it('pins every published triple of the shipped agent-desktop lock', async () => {
    const component = await bundledBinaryComponents()
    expect(component).toMatchObject({
      name: 'agent-desktop',
      versionInfo: '1.1.0',
      licenseDeclared: 'Apache-2.0'
    })
    expect(component.files.length).toBeGreaterThanOrEqual(6)
    for (const file of component.files) {
      expect(file.fileName).toMatch(/^\.\/resources\/agent-desktop\/[a-z0-9-]+\/[a-z0-9.-]+$/)
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(file.size).toBeGreaterThan(0)
    }
    // The CLI executable is named in every triple, so the SBOM cannot list helpers only.
    for (const key of [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64'
    ]) {
      expect(component.files.some((file) => file.fileName.includes(`/${key}/`))).toBe(true)
    }
  })
  it('rejects base64 or truncated artifact checksum values', () => {
    expect(() =>
      createReleaseSbom(app, [], [{ name: 'Ola.zip', sha256: 'not-a-hex-sha256==' }])
    ).toThrow('Invalid artifact SHA256')
  })
})
