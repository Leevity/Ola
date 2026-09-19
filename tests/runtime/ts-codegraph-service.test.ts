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
    await writeFile(join(root, 'helper.ts'), 'export const helper = 1')
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
      nodeCount: 2
    })
    expect(progress).toEqual(['scan', 'complete'])
    await expect(
      service.request('codegraph/stats', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      fileCount: 2,
      filesByLanguage: [expect.objectContaining({ key: 'typescript', count: 2 })]
    })
    await expect(
      service.request('codegraph/files-tree', { workingFolder: root })
    ).resolves.toMatchObject({
      success: true,
      files: [
        expect.objectContaining({ path: 'helper.ts' }),
        expect.objectContaining({ path: 'index.ts' })
      ]
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
