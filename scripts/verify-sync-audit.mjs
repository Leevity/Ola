import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  extractCatalog,
  groupReferenceCandidates,
  parseArgs,
  renderMarkdown
} from './audit-opencowork-sync.mjs'

const catalog = extractCatalog([
  {
    relativePath: 'ipc.ts',
    content: `
      ipcMain.handle('safe:main', handler)
      ipcClient.invoke('safe:client')
      ipcRenderer.send('safe:renderer')
      const metadata = { channel: 'not-an-ipc-channel' }
    `
  }
])
assert.deepEqual(catalog.ipcChannels, ['safe:client', 'safe:main', 'safe:renderer'])

const capabilities = groupReferenceCandidates([
  {
    canonicalPath: 'src/main/hooks/hooks-loader.ts',
    referencePath: 'src/main/hooks/hooks-loader.ts'
  },
  {
    canonicalPath: 'src/renderer/CodeGraphPage.tsx',
    referencePath: 'src/renderer/CodeGraphPage.tsx'
  },
  { canonicalPath: 'src/main/updater.ts', referencePath: 'src/main/updater.ts' },
  { canonicalPath: 'src/main/surprise.ts', referencePath: 'src/main/surprise.ts' }
])
assert.equal(capabilities.Hooks.count, 1)
assert.equal(capabilities.CodeGraph.decision, 'adapt')
assert.equal(capabilities.Distribution.count, 1)
assert.equal(capabilities.Other.decision, 'defer')

const parsed = parseArgs(['--reference', './reference', '--markdown'])
assert.equal(parsed.referenceConfigured, true)
assert.equal(parsed.markdown, true)

const fixture = {
  baseline: {
    ola: { version: '1.0.0' },
    reference: { version: '1.2.2', commit: 'abc', sourceFingerprint: 'def' }
  },
  summary: { files: { identical: 1, onlyReference: 2 } },
  capabilities
}
assert.equal(renderMarkdown(fixture), renderMarkdown(fixture))

const missingRoot = await mkdtemp(path.join(tmpdir(), 'ola-missing-reference-'))
await rm(missingRoot, { recursive: true })
const missingResult = spawnSync(
  process.execPath,
  [
    path.resolve(import.meta.dirname, 'audit-opencowork-sync.mjs'),
    '--reference',
    missingRoot,
    '--check'
  ],
  { encoding: 'utf8' }
)
assert.equal(missingResult.status, 0)
assert.match(missingResult.stdout, /Skipping OpenCowork sync audit/)

console.log('sync audit verification passed')
