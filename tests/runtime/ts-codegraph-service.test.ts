import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TsCodeGraphService } from '../../src/main/codegraph/ts-codegraph-service'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe('TS CodeGraph Main adapter', () => {
  it('keeps a standalone graph, exposes the dashboard contract, and emits index progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-ts-codegraph-project-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'ola-ts-codegraph-data-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }))
    await writeFile(
      join(root, 'index.ts'),
      "import { helper } from './helper'\nexport function run() { return helper }"
    )
    await writeFile(join(root, 'helper.ts'), "import './index'\nexport const helper = 1")
    await writeFile(
      join(root, 'caller.ts'),
      "import { run } from './index'\nexport function main() { return run() }"
    )
    await writeFile(join(root, 'unused.ts'), 'function unusedHelper() { return 1 }')
    const progress: string[] = []
    const service = new TsCodeGraphService(dataRoot, (event) => progress.push(event.phase))
    cleanup.push(() => service.close())

    await expect(
      service.request('codegraph/index-status', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      indexed: false,
      errorKind: 'not_indexed'
    })
    await expect(
      service.request('codegraph/index', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      state: 'complete',
      nodeCount: 4
    })
    await expect(service.request('codegraph/db-smoke')).resolves.toMatchObject({
      success: true,
      runtime: 'ts-wasm',
      backend: 'node:sqlite'
    })
    await expect(
      service.request('codegraph/instructions', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      indexed: true,
      text: expect.stringContaining('TS/WASM')
    })
    await expect(service.request('codegraph/tools-list')).resolves.toMatchObject({
      success: true,
      tools: expect.arrayContaining([expect.objectContaining({ name: 'codegraph_explore' })])
    })
    await expect(
      service.request('codegraph/node', { workingFolder: root, file: 'index.ts' })
    ).resolves.toMatchObject({ success: true, symbols: expect.any(Array) })
    await expect(
      service.request('codegraph/prompt-context', { workingFolder: root, query: 'helper' })
    ).resolves.toMatchObject({ success: true, text: expect.stringContaining('helper') })
    await expect(
      service.request('codegraph/files', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      text: expect.stringContaining('index.ts')
    })
    await expect(
      service.request('codegraph/status', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      text: expect.stringContaining('TS/WASM CodeGraph')
    })
    await expect(service.request('codegraph/list-projects')).resolves.toMatchObject({
      success: true,
      projects: expect.arrayContaining([expect.objectContaining({ root })])
    })
    expect(progress).toEqual(['scan', 'complete'])
    await expect(
      service.request('codegraph/stats', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      fileCount: 4,
      filesByLanguage: [expect.objectContaining({ key: 'typescript', count: 4 })]
    })
    await expect(
      service.request('codegraph/files-tree', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'helper.ts' }),
        expect.objectContaining({ path: 'index.ts' }),
        expect.objectContaining({ path: 'caller.ts' })
      ])
    })
    await expect(
      service.request('codegraph/search', { workingFolder: root, query: 'hel' })
    ).resolves.toMatchObject({
      success: true,
      text: expect.stringContaining('helper.ts')
    })
    await expect(
      service.request('codegraph/query-neighbors', { workingFolder: root, symbol: 'run' })
    ).resolves.toMatchObject({
      success: true,
      nodes: [expect.objectContaining({ name: 'run', filePath: 'index.ts' })],
      edges: [expect.objectContaining({ kind: 'import', target: 'helper.ts' })]
    })
    await expect(
      service.request('codegraph/analytics', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      circularTotal: 1,
      circularDependencies: [{ files: ['helper.ts', 'index.ts'] }],
      deadCodeTotal: 1,
      deadCode: [expect.objectContaining({ name: 'unusedHelper', filePath: 'unused.ts' })]
    })
    await expect(
      service.request('codegraph/callers', { workingFolder: root, symbol: 'run' })
    ).resolves.toMatchObject({
      success: true,
      text: expect.stringContaining('main (function) — caller.ts')
    })
    await expect(
      service.request('codegraph/callees', { workingFolder: root, symbol: 'run' })
    ).resolves.toMatchObject({
      success: true,
      text: expect.stringContaining('helper (variable) — helper.ts')
    })
    await expect(
      service.request('codegraph/impact', { workingFolder: root, symbol: 'run', depth: 2 })
    ).resolves.toMatchObject({
      success: true,
      text: expect.stringContaining('helper (variable) — helper.ts')
    })
    await expect(service.request('codegraph/sync', { workingFolder: root })).resolves.toMatchObject(
      {
        success: true
      }
    )
    await expect(
      service.request('codegraph/remove-project', { workingFolder: root })
    ).resolves.toEqual({
      success: true
    })
  })

  it('rejects an unsafe project root before creating a database', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'ola-ts-codegraph-data-'))
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }))
    const service = new TsCodeGraphService(dataRoot)
    cleanup.push(() => service.close())
    await expect(service.request('codegraph/index', { workingFolder: '/' })).resolves.toMatchObject(
      {
        success: false,
        errorKind: 'path_refusal'
      }
    )
  })
})
