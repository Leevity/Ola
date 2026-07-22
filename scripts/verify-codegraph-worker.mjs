/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, startWorker } from './verify-message-windowing.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const project = path.join(
  repoRoot,
  'sidecars',
  'Ola.CodeGraph.Worker',
  'Ola.CodeGraph.Worker.csproj'
)

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ola-codegraph-verify-'))
  const requestedRoot = process.env.OLA_CODEGRAPH_VERIFY_ROOT?.trim()
  const sourceRoot = requestedRoot ? path.resolve(requestedRoot) : path.join(tempDir, 'project')
  let client
  let child
  try {
    if (!requestedRoot) {
      await mkdir(sourceRoot, { recursive: true })
      await writeFile(
        path.join(sourceRoot, 'sample.ts'),
        'export function greet(name: string) { return `Hello ${name}` }\n'
      )
      for (let index = 0; index < 600; index += 1) {
        await writeFile(
          path.join(sourceRoot, `module-${index}.ts`),
          `export function symbol${index}(value: number) { return value + ${index} }\n`
        )
      }
    }
    ;({ client, child } = await startWorker(tempDir, project, {
      OLA_CODEGRAPH_GRAMMARS_DIR: path.join(
        repoRoot,
        'resources',
        'native-worker',
        'codegraph-worker',
        'grammars'
      ),
      CODEGRAPH_HOME: path.join(tempDir, 'data')
    }))
    const routes = await client.request('worker/routes')
    assert(
      routes.methods.includes('codegraph/index') && routes.methods.includes('codegraph/search'),
      'CodeGraph worker routes are incomplete'
    )
    const status = await client.request('codegraph/status', { workingFolder: sourceRoot })
    assert(status.success, `CodeGraph status failed: ${JSON.stringify(status)}`)
    const progressStarted = new Promise((resolve) => {
      const unsubscribe = client.onEvent('codegraph/index-progress', () => {
        unsubscribe()
        resolve()
      })
    })
    const indexPromise = client.request('codegraph/index', { workingFolder: sourceRoot }, 120_000)
    await Promise.race([progressStarted, new Promise((resolve) => setTimeout(resolve, 2_000))])
    const liveStatus = await client.request(
      'codegraph/index-status',
      { workingFolder: sourceRoot },
      5_000
    )
    assert(
      liveStatus.success && liveStatus.indexed,
      `CodeGraph live index status failed: ${JSON.stringify(liveStatus)}`
    )
    const liveStats = await client.request('codegraph/stats', { workingFolder: sourceRoot }, 5_000)
    assert(liveStats.success, `CodeGraph live stats failed: ${JSON.stringify(liveStats)}`)
    const indexed = await indexPromise
    assert(indexed.success, `CodeGraph index failed: ${JSON.stringify(indexed)}`)
    const searched = await client.request('codegraph/search', {
      workingFolder: sourceRoot,
      query: requestedRoot ? 'App' : 'greet'
    })
    assert(searched.success, `CodeGraph search failed: ${JSON.stringify(searched)}`)
    const indexStatus = await client.request('codegraph/index-status', {
      workingFolder: sourceRoot
    })
    assert(
      indexStatus.success && indexStatus.indexed && indexStatus.nodeCount > 0,
      `CodeGraph index status failed: ${JSON.stringify(indexStatus)}`
    )
    const stats = await client.request('codegraph/stats', { workingFolder: sourceRoot })
    assert(
      stats.success && stats.filesByLanguage.some((bucket) => bucket.key === 'typescript'),
      `CodeGraph stats failed: ${JSON.stringify(stats)}`
    )
    const neighbors = await client.request('codegraph/query-neighbors', {
      workingFolder: sourceRoot,
      symbol: requestedRoot ? 'App' : 'greet',
      depth: 1,
      limit: 80
    })
    assert(
      neighbors.success && neighbors.nodes.length > 0,
      `CodeGraph neighbors failed: ${JSON.stringify(neighbors)}`
    )
    console.log('codegraph worker verification passed')
  } finally {
    client?.close()
    if (child && child.exitCode === null) child.kill()
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
