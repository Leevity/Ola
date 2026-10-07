import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const dependencies = await collectRuntimeMainDependencies(root, packageJson, externalDependencies)
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
  await stageCodegraphGrammars(root, staging)
  await writeFile(
    join(staging, 'package.json'),
    `${JSON.stringify({ ...packageJson, scripts: stagingScripts, dependencies, devDependencies: stagingDevDependencies }, null, 2)}\n`
  )
  await execFileAsync(process.execPath, [npmCli, 'install', '--no-package-lock'], {
    cwd: staging,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    maxBuffer: 10 * 1024 * 1024
  })
  const targetPlatform = platform === 'win' ? 'win32' : platform === 'mac' ? 'darwin' : 'linux'
  const targetArch = process.arch
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

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      electronBuilderCli,
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
  const macOutputName = targetArch === 'x64' ? 'mac' : `mac-${targetArch}`
  const unpackedOutput =
    platform === 'mac'
      ? join(staging, 'dist', macOutputName)
      : join(staging, 'dist', `${platform}-unpacked`)
  await execFileAsync(
    process.execPath,
    [
      join(root, 'scripts/verify-runtime-staging.mjs'),
      unpackedOutput,
      `--platform=${targetPlatform}`
    ],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 }
  )
  console.log(`Runtime dependency staging package created at ${join(staging, 'dist')}`)
} finally {
  if (!keepStaging) await rm(staging, { recursive: true, force: true })
}
