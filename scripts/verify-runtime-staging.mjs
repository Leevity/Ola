import { access, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
  join(appUnpacked, 'out', 'main', 'legacy-read-worker.mjs'),
  join(appUnpacked, 'resources', 'native-worker', 'Ola.Native.Worker')
]
for (const path of required) {
  await access(path)
  const info = await stat(path)
  if (!info.isFile() && !info.isDirectory()) throw new Error(`Invalid staging artifact: ${path}`)
}
console.log(`runtime staging integrity passed: ${platform} ${root}`)
