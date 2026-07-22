import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGrammarManifest, nativeLibraryFileName } from './codegraph-grammar-manifest.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function currentRid() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  throw new Error(`unsupported platform: ${process.platform}/${process.arch}`)
}

function executableName(id, rid) {
  const product = id === 'native-worker' ? 'Ola.Native.Worker' : 'Ola.CodeGraph.Worker'
  return rid.startsWith('win-') ? `${product}.exe` : product
}

function inspectFile(file) {
  if (!existsSync(file)) return { path: file, ready: false, reason: 'missing' }
  const stat = statSync(file)
  if (!stat.isFile() || stat.size === 0) {
    return { path: file, ready: false, reason: 'invalid-file', size: stat.size }
  }
  return {
    path: file,
    ready: true,
    size: stat.size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
  }
}

export function inspectWorkerAssets({ root, rid }) {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'src/shared/worker-assets.json'), 'utf8')
  )
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error('worker asset manifest is invalid')
  }
  const grammarManifest = loadGrammarManifest()
  const results = []
  for (const asset of manifest.assets) {
    const directory = path.join(root, asset.directory)
    if (asset.kind === 'grammar-set') {
      const libraries = [
        grammarManifest.runtime.library,
        ...grammarManifest.grammars.map((item) => item.library)
      ]
      const files = libraries.map((library) =>
        inspectFile(path.join(directory, nativeLibraryFileName(library, rid)))
      )
      results.push({ ...asset, directory, ready: files.every((item) => item.ready), files })
      continue
    }
    const file = path.join(directory, executableName(asset.id, rid))
    const inspected = inspectFile(file)
    results.push({ ...asset, directory, ready: inspected.ready, files: [inspected] })
  }
  return {
    schemaVersion: 1,
    rid,
    root,
    ready: results.filter((item) => item.required).every((item) => item.ready),
    assets: results
  }
}

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const positional = args.filter((arg) => arg !== '--strict')
const status = inspectWorkerAssets({
  root: path.resolve(positional[0] ?? path.join(repoRoot, 'resources/native-worker')),
  rid: positional[1] ?? process.env.OLA_NATIVE_WORKER_RID ?? currentRid()
})
console.log(JSON.stringify(status, null, 2))
if (strict && !status.ready) process.exitCode = 1
