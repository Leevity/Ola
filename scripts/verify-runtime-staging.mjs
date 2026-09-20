import { access, lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

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
  join(appUnpacked, 'out', 'main', 'business-worker.mjs'),
  join(appUnpacked, 'out', 'main', 'graph-store-worker.mjs')
]
for (const path of required) {
  await access(path)
  const info = await stat(path)
  if (!info.isFile() && !info.isDirectory()) throw new Error(`Invalid staging artifact: ${path}`)
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
