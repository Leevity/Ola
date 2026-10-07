import { cp, mkdir, mkdtemp, readFile, rm, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { collectRuntimeMainDependencies } from './runtime-main-dependencies.mjs'
import { stageCodegraphGrammars } from './stage-codegraph-grammars.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli =
  process.env.npm_execpath ??
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const electronBuilderCli = join(root, 'node_modules', 'electron-builder', 'cli.js')

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

const requestedPlatforms = ['win', 'linux', 'mac'].filter((name) =>
  process.argv.includes(`--${name}`)
)
if (requestedPlatforms.length !== 1) {
  throw new Error('Specify exactly one release platform: --win, --linux, or --mac')
}
const platform = requestedPlatforms[0]
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
const dependencies = await collectRuntimeMainDependencies(root, packageJson, externalDependencies)
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
  await stageCodegraphGrammars(root, staging)
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
  await execFileAsync(process.execPath, [npmCli, 'install', '--no-package-lock'], {
    cwd: staging,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    maxBuffer: 10 * 1024 * 1024
  })

  const targetPlatform = platform === 'win' ? 'win32' : platform === 'mac' ? 'darwin' : 'linux'
  const targetArch = arch ?? process.arch
  const { stdout: rebuildStdout, stderr: rebuildStderr } = await execFileAsync(
    process.execPath,
    [join(root, 'scripts/postinstall.mjs')],
    {
      cwd: staging,
      env: { ...process.env, OLA_TARGET_PLATFORM: targetPlatform, OLA_TARGET_ARCH: targetArch },
      maxBuffer: 10 * 1024 * 1024
    }
  )
  process.stdout.write(rebuildStdout)
  process.stderr.write(rebuildStderr)

  const targets = directoryOnly
    ? ['--dir']
    : platform === 'mac'
      ? ['dmg', 'zip']
      : platform === 'win'
        ? ['nsis', 'zip']
        : ['AppImage', 'deb']
  const args = [
    '--projectDir',
    staging,
    '--config',
    join(staging, 'electron-builder.yml'),
    `--${platform}`,
    ...targets,
    '--publish',
    'never',
    '--config.directories.output=dist'
  ]
  if (arch) args.push('--' + arch)
  if (platform === 'mac') args.push('-c.mac.notarize=false')

  const { stdout, stderr } = await execFileAsync(process.execPath, [electronBuilderCli, ...args], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
    maxBuffer: 30 * 1024 * 1024
  })
  process.stdout.write(stdout)
  process.stderr.write(stderr)

  const macArch = targetArch
  const macOutputName = macArch === 'x64' ? 'mac' : `mac-${macArch}`
  const unpackedOutput =
    platform === 'mac'
      ? join(staging, 'dist', macOutputName)
      : join(staging, 'dist', `${platform}-unpacked`)
  const platformName = targetPlatform
  await execFileAsync(
    process.execPath,
    [
      join(root, 'scripts/verify-runtime-staging.mjs'),
      unpackedOutput,
      `--platform=${platformName}`
    ],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 }
  )

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
