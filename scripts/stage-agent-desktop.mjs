import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'resources', 'agent-desktop.lock.json')
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

export const agentDesktopResourceDirName = 'agent-desktop'

export async function readAgentDesktopLock(path = lockPath) {
  const lock = JSON.parse(await readFile(path, 'utf8'))
  if (!lock || typeof lock !== 'object' || !lock.platforms) {
    throw new Error(`Invalid agent-desktop lock: ${path}`)
  }
  if (!/^https:\/\/[^\s]+$/.test(lock.archiveBaseUrl ?? '')) {
    throw new Error('agent-desktop lock must pin an https archive base URL')
  }
  for (const [key, entry] of Object.entries(lock.platforms)) {
    if (!entry.cli || !entry.binaries?.[entry.cli]) {
      throw new Error(`agent-desktop lock entry ${key} must name its CLI binary`)
    }
    if (/\.{2,}/.test(entry.archive) || entry.archive.includes('/')) {
      throw new Error(`agent-desktop lock entry ${key} has an unsafe archive name`)
    }
  }
  return lock
}

export function agentDesktopPlatformKey(osPlatform = process.platform, osArch = process.arch) {
  return `${osPlatform}-${osArch}`
}

export async function agentDesktopEntry(platformKey, lock) {
  const resolvedLock = lock ?? (await readAgentDesktopLock())
  const entry = resolvedLock.platforms[platformKey]
  if (!entry) throw new Error(`agent-desktop is not published for ${platformKey}`)
  return { ...entry, key: platformKey, version: resolvedLock.version }
}

// Windows installs sometimes put GNU tar on PATH and that build misreads drive-letter
// paths; bsdtar in System32 is in-box on every supported Windows version.
export function tarCommand(environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'tar'
  const systemRoot = environment.SystemRoot || environment.windir
  if (!systemRoot) return 'tar'
  const inBox = join(systemRoot, 'System32', 'tar.exe')
  return existsSync(inBox) ? inBox : 'tar'
}

async function sha256Of(path) {
  const bytes = await readFile(path)
  return { digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

/** Hash every binary already staged for `platformKey`; `complete` means all pins match. */
export async function inspectAgentDesktopBinaries(sourceRoot, platformKey, lock) {
  const entry = await agentDesktopEntry(platformKey, lock)
  const dir = join(sourceRoot, 'resources', agentDesktopResourceDirName, entry.key)
  const missing = []
  const mismatched = []
  for (const [name, pin] of Object.entries(entry.binaries)) {
    let info
    try {
      info = await stat(join(dir, name))
    } catch {
      missing.push(name)
      continue
    }
    if (!info.isFile()) {
      mismatched.push(`${name} is not a regular file`)
      continue
    }
    const { digest, size } = await sha256Of(join(dir, name))
    if (digest !== pin.sha256) mismatched.push(`${name} sha256 ${digest}`)
    else if (size !== pin.size) mismatched.push(`${name} size ${size}`)
  }
  return {
    dir,
    entry,
    complete: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched
  }
}

async function fetchArchive(entry, archiveBaseUrl) {
  const url = new URL(`${archiveBaseUrl}/${entry.archive}`)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error(`agent-desktop archive must come from github.com over https: ${url}`)
  }
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`agent-desktop archive download failed: ${response.status} ${url}`)
  }
  const hash = createHash('sha256')
  const chunks = []
  let received = 0
  for await (const piece of response.body) {
    const chunk = Buffer.from(piece)
    received += chunk.length
    if (received > entry.size || received > MAX_ARCHIVE_BYTES) {
      throw new Error(`agent-desktop archive exceeds its pinned size: ${entry.archive}`)
    }
    hash.update(chunk)
    chunks.push(chunk)
  }
  const digest = hash.digest('hex')
  if (received !== entry.size || digest !== entry.sha256) {
    throw new Error(
      `agent-desktop archive integrity check failed: ${entry.archive} sha256 ${digest} size ${received}`
    )
  }
  return Buffer.concat(chunks)
}

/**
 * Extract only the binaries named in the lock. Members are enumerated before extraction so a
 * path-traversal or extra payload in the archive fails closed instead of landing on disk.
 */
async function extractLockedBinaries(archiveBuffer, entry, destination) {
  const work = await mkdtemp(join(tmpdir(), 'ola-agent-desktop-'))
  try {
    const archivePath = join(work, entry.archive)
    await writeFile(archivePath, archiveBuffer)
    const tar = tarCommand()
    const { stdout } = await execFileAsync(tar, ['-tzf', archivePath], {
      maxBuffer: 4 * 1024 * 1024
    })
    const members = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\.\//, ''))
      .filter(Boolean)
    const allowed = new Set(Object.keys(entry.binaries))
    for (const member of members) {
      if (member !== basename(member) || member === '..') {
        throw new Error(`agent-desktop archive contains a nested path: ${member}`)
      }
      if (!allowed.has(member)) {
        throw new Error(`agent-desktop archive contains an unpinned file: ${member}`)
      }
    }
    for (const name of allowed) {
      if (!members.includes(name)) {
        throw new Error(`agent-desktop archive is missing ${name}`)
      }
    }
    await execFileAsync(tar, ['-xzf', archivePath, '-C', work], { maxBuffer: 4 * 1024 * 1024 })
    await mkdir(destination, { recursive: true })
    for (const [name, pin] of Object.entries(entry.binaries)) {
      const source = join(work, name)
      const target = join(destination, name)
      await rm(target, { force: true })
      await writeFile(target, await readFile(source))
      await chmod(target, 0o755)
      const { digest } = await sha256Of(target)
      if (digest !== pin.sha256) {
        await rm(target, { force: true })
        throw new Error(`agent-desktop binary sha256 mismatch after extraction: ${name} ${digest}`)
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Ensure `sourceRoot/resources/agent-desktop/<platformKey>` holds the pinned binaries. */
export async function fetchAgentDesktopBinaries(sourceRoot, platformKey, options = {}) {
  const lock = options.lock ?? (await readAgentDesktopLock())
  const entry = await agentDesktopEntry(platformKey, lock)
  const destination = join(sourceRoot, 'resources', agentDesktopResourceDirName, entry.key)
  if (!options.force) {
    const state = await inspectAgentDesktopBinaries(sourceRoot, platformKey, lock)
    if (state.complete) return { ...state, fetched: false }
  }
  console.log(`Fetching agent-desktop ${entry.version} for ${entry.key}`)
  const archive = await fetchArchive(entry, lock.archiveBaseUrl)
  await extractLockedBinaries(archive, entry, destination)
  const state = await inspectAgentDesktopBinaries(sourceRoot, platformKey, lock)
  if (!state.complete) {
    throw new Error(
      `agent-desktop staging incomplete for ${entry.key}: ${[...state.missing, ...state.mismatched].join(', ')}`
    )
  }
  return { ...state, fetched: true }
}

/**
 * Copy exactly one target triple into release staging. Other host-side triples are dropped so a
 * dev who fetched all six cannot leak ~25 MB of foreign-arch executables into an installer.
 */
export async function stageAgentDesktop(sourceRoot, stagingRoot, targetPlatform, targetArch) {
  const lock = await readAgentDesktopLock()
  const platformKey = agentDesktopPlatformKey(targetPlatform, targetArch)
  const state = await fetchAgentDesktopBinaries(sourceRoot, platformKey, { lock })
  const destination = join(stagingRoot, 'resources', agentDesktopResourceDirName)
  await rm(destination, { recursive: true, force: true })
  await mkdir(join(destination, state.entry.key), { recursive: true })
  for (const name of Object.keys(state.entry.binaries)) {
    const target = join(destination, state.entry.key, name)
    await writeFile(target, await readFile(join(state.dir, name)))
    await chmod(target, 0o755)
  }
  const notice = join(sourceRoot, 'resources', agentDesktopResourceDirName, 'NOTICE.md')
  if (existsSync(notice)) await cp(notice, join(destination, 'NOTICE.md'))
  return state
}

async function parseArgs(argv) {
  const lock = await readAgentDesktopLock()
  const values = argv.filter((arg) => arg.startsWith('--'))
  const read = (name) => values.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const modeCheck = values.includes('--check')
  const force = values.includes('--force')
  const keys = values.includes('--all')
    ? Object.keys(lock.platforms)
    : [agentDesktopPlatformKey(read('platform') ?? process.platform, read('arch') ?? process.arch)]
  return { lock, keys, modeCheck, force }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { lock, keys, modeCheck, force } = await parseArgs(process.argv.slice(2))
  for (const key of keys) {
    if (modeCheck) {
      const state = await inspectAgentDesktopBinaries(root, key, lock)
      if (!state.complete) {
        throw new Error(
          `agent-desktop ${key} is not pinned locally: ${[...state.missing, ...state.mismatched].join(', ')}`
        )
      }
      console.log(`agent-desktop ${key} matches lock ${lock.version}`)
      continue
    }
    const state = await fetchAgentDesktopBinaries(root, key, { lock, force })
    console.log(
      `agent-desktop ${key} ${state.fetched ? 'fetched' : 'already staged'} at ${state.dir}`
    )
  }
}
