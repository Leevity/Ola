import { cp, mkdir, mkdtemp, readFile, rm, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Vite bundles the renderer and most Main imports. These are the modules that
// remain runtime dependencies and must stay visible to electron-builder.
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
const directoryOnly = process.argv.includes('--dir')
const arch = process.argv.includes('--x64')
  ? 'x64'
  : process.argv.includes('--arm64')
    ? 'arm64'
    : null
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
const staging = await mkdtemp('/tmp/ola-release-package-')
const outputName = `dist-staged-${platform}${arch ? `-${arch}` : ''}`
const output = join(root, outputName)

// This file is intentionally plain ESM so it can run before the app build.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function copyIfPresent(name) {
  try {
    await stat(join(root, name))
  } catch {
    throw new Error(`Required release input is missing: ${name}`)
  }
  await cp(join(root, name), join(staging, name), { recursive: true })
}

try {
  await mkdir(staging, { recursive: true })
  await Promise.all(['out', 'resources', 'build', 'electron-builder.yml'].map(copyIfPresent))
  await writeFile(
    join(staging, 'package.json'),
    `${JSON.stringify(
      {
        ...packageJson,
        scripts: stagingScripts,
        dependencies,
        devDependencies: stagingDevDependencies
      },
      null,
      2
    )}\n`
  )
  await execFileAsync('npm', ['install', '--no-package-lock'], {
    cwd: staging,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    maxBuffer: 10 * 1024 * 1024
  })

  const targets = directoryOnly
    ? ['--dir']
    : platform === 'mac'
      ? ['dmg', 'zip']
      : platform === 'win'
        ? ['nsis', 'zip']
        : ['AppImage', 'deb']
  const args = [
    'electron-builder',
    '--projectDir',
    staging,
    '--config',
    join(staging, 'electron-builder.yml'),
    `--${platform}`,
    ...targets,
    '--publish',
    'never',
    '-c.directories.output=dist'
  ]
  if (arch) args.push('--' + arch)
  if (platform === 'mac') args.push('-c.mac.notarize=false')

  const { stdout, stderr } = await execFileAsync('npx', args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
    maxBuffer: 30 * 1024 * 1024
  })
  process.stdout.write(stdout)
  process.stderr.write(stderr)

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const artifacts = await readdir(join(staging, 'dist'))
  for (const artifact of artifacts) {
    await cp(join(staging, 'dist', artifact), join(output, artifact), {
      recursive: true,
      verbatimSymlinks: true
    })
  }
  console.log(`Release staging artifacts copied to ${output}`)
} finally {
  if (!keepStaging) await rm(staging, { recursive: true, force: true })
}
