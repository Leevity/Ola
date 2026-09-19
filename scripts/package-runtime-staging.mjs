import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const externalDependencies = [
  '@jitsi/robotjs',
  '@larksuiteoapi/node-sdk',
  '@modelcontextprotocol/sdk',
  '@msgpack/msgpack',
  'better-sqlite3',
  'dingtalk-stream',
  'electron-updater',
  'glob',
  'jszip',
  'nanoid',
  'node-cron',
  'node-pty',
  'ssh2',
  'web-tree-sitter',
  'ws'
]

const platform = process.argv.includes('--win')
  ? 'win'
  : process.argv.includes('--linux')
    ? 'linux'
    : 'mac'
const keepStaging = process.argv.includes('--keep')

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const stagingScripts = { ...packageJson.scripts }
delete stagingScripts.preinstall
delete stagingScripts.postinstall
const dependencies = Object.fromEntries(
  externalDependencies
    .filter((name) => packageJson.dependencies?.[name])
    .map((name) => [name, packageJson.dependencies[name]])
)
const stagingDevDependencies = packageJson.devDependencies?.electron
  ? { electron: packageJson.devDependencies.electron }
  : {}
const staging = await mkdtemp('/tmp/ola-runtime-package-')
await mkdir(staging, { recursive: true })

try {
  await Promise.all(
    ['out', 'resources', 'build', 'electron-builder.yml'].map((name) =>
      cp(join(root, name), join(staging, name), { recursive: true })
    )
  )
  await writeFile(
    join(staging, 'package.json'),
    `${JSON.stringify({ ...packageJson, scripts: stagingScripts, dependencies, devDependencies: stagingDevDependencies }, null, 2)}\n`
  )
  await execFileAsync('npm', ['install', '--no-package-lock'], {
    cwd: staging,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    maxBuffer: 10 * 1024 * 1024
  })
  const { stdout, stderr } = await execFileAsync(
    'npx',
    [
      'electron-builder',
      '--projectDir',
      staging,
      '--config',
      join(staging, 'electron-builder.yml'),
      `--${platform}`,
      '--dir'
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
      maxBuffer: 20 * 1024 * 1024
    }
  )
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  console.log(`Runtime dependency staging package created at ${join(staging, 'dist')}`)
} finally {
  if (!keepStaging) await rm(staging, { recursive: true, force: true })
}
