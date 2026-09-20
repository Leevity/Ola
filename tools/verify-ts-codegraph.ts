import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TsCodeGraphService } from '../src/main/codegraph/ts-codegraph-service'

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ola-ts-codegraph-'))
const bundledWorkerPath = path.resolve('node_modules/runtime/graph-store-worker.mjs')
await mkdir(path.dirname(bundledWorkerPath), { recursive: true })
await copyFile('src/runtime/codegraph/graph-store-worker.mjs', bundledWorkerPath)
const projectRoot = path.join(temporaryRoot, 'project')
await mkdir(projectRoot, { recursive: true })
await writeFile(
  path.join(projectRoot, 'main.ts'),
  'export function greet(name: string) { return name }\n'
)
await writeFile(path.join(projectRoot, 'helper.ts'), 'export const value = 1\n')

const service = new TsCodeGraphService(path.join(temporaryRoot, 'graph'))
try {
  const indexed = (await service.request('codegraph/index', { workingFolder: projectRoot })) as {
    success: boolean
    filesIndexed?: number
  }
  console.log(`TS CodeGraph index result: ${JSON.stringify(indexed)}`)
  assert.equal(indexed.success, true)
  assert.ok((indexed.filesIndexed ?? 0) >= 0)
  const search = (await service.request('codegraph/search', {
    workingFolder: projectRoot,
    query: 'greet'
  })) as { success: boolean; text?: string }
  console.log(`TS CodeGraph search result: ${JSON.stringify(search)}`)
  assert.equal(search.success, true)
  assert.match(search.text ?? '', /greet/)
  const status = (await service.request('codegraph/status', { workingFolder: projectRoot })) as {
    success: boolean
  }
  assert.equal(status.success, true)
  console.log('TS/WASM CodeGraph verification passed')
} finally {
  await service.close()
  await rm(temporaryRoot, { recursive: true, force: true })
}
