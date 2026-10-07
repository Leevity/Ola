import { access, lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { isLegacyRuntimeArtifactPath } from './legacy-runtime-artifact-patterns.mjs'
import { packagedCodegraphGrammarNames } from './stage-codegraph-grammars.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')

const args = process.argv.slice(2)
const platform = args.find((arg) => arg.startsWith('--platform='))?.slice('--platform='.length)
const rootArg = args.find((arg) => !arg.startsWith('--'))
if (!platform || !rootArg || !['darwin', 'linux', 'win32'].includes(platform)) {
  throw new Error('Usage: verify-runtime-staging.mjs <unpacked-dir> --platform=darwin|linux|win32')
}

const root = resolve(rootArg)
const executable =
  platform === 'darwin'
    ? join(root, 'Ola.app', 'Contents', 'MacOS', 'Ola')
    : join(root, platform === 'win32' ? 'ola.exe' : 'ola')
const resourceRoot =
  platform === 'darwin' ? join(root, 'Ola.app', 'Contents', 'Resources') : join(root, 'resources')
const appUnpacked = join(resourceRoot, 'app.asar.unpacked')
const required = [
  executable,
  join(resourceRoot, 'app.asar'),
  join(appUnpacked, 'out', 'main', 'business-worker.mjs'),
  join(appUnpacked, 'out', 'main', 'graph-store-worker.mjs'),
  join(appUnpacked, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
  ...packagedCodegraphGrammarNames.map((grammar) =>
    join(appUnpacked, 'resources', 'codegraph', 'grammars', `tree-sitter-${grammar}.wasm`)
  )
]
for (const path of required) {
  await access(path)
  const info = await stat(path)
  if (!info.isFile() && !info.isDirectory()) throw new Error(`Invalid staging artifact: ${path}`)
}

const archiveEntries = asar.listPackage(join(resourceRoot, 'app.asar'))
const sourceMaps = archiveEntries.filter((path) => path.toLowerCase().endsWith('.map'))
if (sourceMaps.length > 0) {
  throw new Error(`Production staging contains source maps: ${sourceMaps.slice(0, 5).join(', ')}`)
}
const legacyArtifacts = archiveEntries.filter(isLegacyRuntimeArtifactPath)
if (legacyArtifacts.length > 0) {
  throw new Error(
    `Production staging contains legacy runtime artifacts in app.asar: ${legacyArtifacts.slice(0, 5).join(', ')}`
  )
}

const forbiddenLegacyWorkerPaths = [join(appUnpacked, 'resources', 'native-worker')]
for (const path of forbiddenLegacyWorkerPaths) {
  try {
    await access(path)
  } catch {
    continue
  }
  throw new Error(`Production staging must not contain legacy native-worker assets: ${path}`)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function verifyLinks(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    const target = await realpath(path)
    const outside = relative(root, target)
    if (outside === '..' || outside.startsWith(`..${pathSeparator}`))
      throw new Error(`Staging symlink escapes artifact root: ${path} -> ${target}`)
    return
  }
  if (!info.isDirectory()) return
  for (const entry of await readdir(path)) await verifyLinks(join(path, entry))
}

const pathSeparator = process.platform === 'win32' ? '\\' : '/'
await verifyLinks(root)
console.log(`runtime staging integrity passed: ${platform} ${root}`)
