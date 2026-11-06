/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Bundled-binary signing and containment rules for the agent-desktop accessibility CLI.
 *
 * The CLI ships as a bare Mach-O under `resources/`, which the app bundle's own signature does not
 * cover unless something signs it deliberately. Apple rejects a notarized app containing an
 * unsigned or foreign-architecture executable, so the release proves both per file instead of
 * assuming the bundler did it. Every rule runs with an ad-hoc identity too, so a build without a
 * certificate exercises the same path a Developer ID build does.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  agentDesktopEntry,
  agentDesktopPlatformKey,
  agentDesktopResourceDirName
} from './stage-agent-desktop.mjs'

const execFileAsync = promisify(execFile)

/** Run `codesign` and return combined output; `codesign -dvvv` reports to stderr. */
export async function codesignRunner(args) {
  try {
    const { stdout, stderr } = await execFileAsync('codesign', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
    return `${stdout}${stderr}`
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}`
        : String(error)
    throw new Error(`codesign ${args.join(' ')} failed: ${detail}`)
  }
}

const CPU64_X86 = 0x01000007
const CPU64_ARM = 0x0100000c
// Magic values as read big-endian, so the name says which endianness the *file* was written in:
// a normal x64/arm64 slice stores MH_MAGIC_64 little-endian, which reads back as 0xcffaedfe.
const THIN_64_LE = 0xcffaedfe
const THIN_64_BE = 0xfeedfacf
const THIN_32_LE = 0xcefaedfe
const THIN_32_BE = 0xfeedface
const FAT_32 = 0xcafebabe
const FAT_64 = 0xcafebabf
const FAT_32_SWAPPED = 0xbebafeca
const FAT_64_SWAPPED = 0xbfabefac

/**
 * Read the architectures a Mach-O actually contains, from its header.
 *
 * `lipo` and `file` are not guaranteed on a build machine, and an architecture claim taken from a
 * filename is a claim about the lock file rather than about the bytes that shipped.
 *
 * @param {Buffer} bytes
 * @returns {string[]} architecture names in Node's spelling (`arm64`, `x64`)
 */
export function readMachOArchitectures(bytes) {
  if (bytes.length < 8) throw new Error('not a Mach-O: shorter than a header')
  const magic = bytes.readUInt32BE(0)
  if (
    magic === FAT_32 ||
    magic === FAT_32_SWAPPED ||
    magic === FAT_64 ||
    magic === FAT_64_SWAPPED
  ) {
    // A fat header is big-endian by definition; the swapped magics mark a host that wrote it the
    // other way round, and every field in the architecture table follows that endianness.
    const littleEndian = magic === FAT_32_SWAPPED || magic === FAT_64_SWAPPED
    const is64 = magic === FAT_64 || magic === FAT_64_SWAPPED
    const count = readUint(bytes, 4, littleEndian)
    const entrySize = is64 ? 32 : 20
    if (count < 1 || bytes.length < 8 + count * entrySize) {
      throw new Error('not a Mach-O: truncated fat architecture table')
    }
    const architectures = []
    for (let index = 0; index < count; index += 1) {
      architectures.push(architectureName(readUint(bytes, 8 + index * entrySize, littleEndian)))
    }
    return [...new Set(architectures)]
  }
  const littleEndian = magic === THIN_64_LE || magic === THIN_32_LE
  if (!littleEndian && magic !== THIN_64_BE && magic !== THIN_32_BE) {
    throw new Error(`not a Mach-O: unknown magic 0x${magic.toString(16)}`)
  }
  // mach_header and mach_header_64 share magic, cputype, cpusubtype as their first three fields.
  return [architectureName(readUint(bytes, 4, littleEndian))]
}

/** @param {Buffer} bytes @param {number} offset @param {boolean} littleEndian @returns {number} */
function readUint(bytes, offset, littleEndian) {
  if (bytes.length < offset + 4) throw new Error('not a Mach-O: truncated header')
  return littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
}

/** @param {number} cputype @returns {string} */
function architectureName(cputype) {
  if (cputype === CPU64_ARM) return 'arm64'
  if (cputype === CPU64_X86) return 'x64'
  throw new Error(`unsupported Mach-O cpu type 0x${cputype.toString(16)}`)
}

/**
 * @param {Buffer} bytes
 * @param {string} architecture
 * @returns {boolean}
 */
export function containsArchitecture(bytes, architecture) {
  return readMachOArchitectures(bytes).includes(architecture)
}

/**
 * The architectures the bundle itself claims, read from its main executable.
 *
 * Taking the architecture from the app binary rather than from the build invocation means the rule
 * checks the artifact that ships, so an arm64 build that picked up an x64 helper is a failure.
 *
 * @param {{appPath: string, executable: string}} options
 * @returns {Promise<string[]>}
 */
export async function readBundleArchitectures({ appPath, executable }) {
  const file = join(appPath, 'Contents', 'MacOS', executable)
  let bytes
  try {
    bytes = await readFile(file)
  } catch {
    throw new Error(`macOS app executable is missing from the bundle: ${file}`)
  }
  return readMachOArchitectures(bytes)
}

/**
 * Resolve which agent-desktop triple belongs in this bundle.
 *
 * @param {{appPath: string, executable: string, platform?: NodeJS.Platform}} options
 */
export async function agentDesktopBundleKey({ appPath, executable, platform = process.platform }) {
  const architectures = await readBundleArchitectures({ appPath, executable })
  if (architectures.length !== 1) {
    throw new Error(
      `only single-architecture macOS bundles are supported; this app is ${architectures.join(', ')}`
    )
  }
  return {
    key: agentDesktopPlatformKey(platform, architectures[0]),
    architecture: architectures[0]
  }
}

/**
 * The binaries this bundle must contain, resolved from the lock rather than from a directory
 * listing, so a missing or renamed file is a failure instead of an unnoticed gap.
 *
 * @param {{appPath: string, executable: string, platform?: NodeJS.Platform}} options
 */
export async function listAgentDesktopBinaries({
  appPath,
  executable,
  platform = process.platform
}) {
  const { key, architecture } = await agentDesktopBundleKey({ appPath, executable, platform })
  const entry = await agentDesktopEntry(key)
  const directory = join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'resources',
    agentDesktopResourceDirName,
    key
  )
  const files = Object.keys(entry.binaries).map((name) => join(directory, name))
  for (const file of files) {
    try {
      await readFile(file)
    } catch {
      throw new Error(
        `agent-desktop binary ${file} is missing from the bundle; run npm run fetch:agent-desktop before packaging`
      )
    }
  }
  return { files, architecture, key }
}

/**
 * Sign every pinned binary for this triple before the bundle itself is signed.
 *
 * @param {{appPath: string, executable: string, platform?: NodeJS.Platform, identity?: string,
 *          codesign?: (args: string[]) => Promise<string>}} options
 */
export async function signAgentDesktopBinaries({
  appPath,
  executable,
  platform = process.platform,
  identity = '-',
  codesign = codesignRunner
}) {
  const { files, architecture } = await listAgentDesktopBinaries({ appPath, executable, platform })
  // A real identity must carry a timestamp and the hardened runtime flag, because these files sit
  // inside a notarized bundle. An ad-hoc signature cannot be timestamped offline.
  const options = identity === '-' ? ['--timestamp=none'] : ['--timestamp', '--options', 'runtime']
  for (const file of files) {
    assertArchitecture(file, await readFile(file), architecture)
    await codesign(['--force', '--sign', identity, ...options, file])
  }
  return files
}

/**
 * Prove the shipped bundle carries the pinned binaries, built for the architecture the bundle
 * claims, and signed by the same identity as the app.
 *
 * @param {{appPath: string, executable: string, platform?: NodeJS.Platform, requireSignature?: boolean,
 *          codesign?: (args: string[]) => Promise<string>}} options
 */
export async function verifyAgentDesktopSignatures({
  appPath,
  executable,
  platform = process.platform,
  requireSignature = true,
  codesign = codesignRunner
}) {
  const { files, architecture } = await listAgentDesktopBinaries({ appPath, executable, platform })
  const appIdentity = requireSignature
    ? readIdentityFields(
        await codesign(['-dvvv', join(appPath, 'Contents', 'MacOS', executable)]),
        appPath
      )
    : null
  for (const file of files) {
    const bytes = await readFile(file)
    if (!containsArchitecture(bytes, architecture)) {
      throw new Error(
        `agent-desktop binary ${file} is not an ${architecture} Mach-O; found ${readMachOArchitectures(bytes).join(', ')}`
      )
    }
    if (!requireSignature) continue
    const identity = readIdentityFields(await codesign(['-dvvv', file]), file)
    if (identity.adhoc) {
      throw new Error(
        `agent-desktop binary ${file} is only ad-hoc signed; a release must sign it with the Developer ID that signed ${appPath}`
      )
    }
    if (appIdentity && identity.teamIdentifier !== appIdentity.teamIdentifier) {
      throw new Error(
        `agent-desktop binary ${file} is signed by team ${identity.teamIdentifier || 'none'}, but the app is ${appIdentity.teamIdentifier}`
      )
    }
  }
  return files
}

/** @param {string} file @param {Buffer} bytes @param {string} architecture */
function assertArchitecture(file, bytes, architecture) {
  if (!containsArchitecture(bytes, architecture)) {
    throw new Error(
      `agent-desktop binary ${file} is not an ${architecture} Mach-O; found ${readMachOArchitectures(bytes).join(', ')}`
    )
  }
}

/**
 * Parse the fields `codesign -dvvv` prints.
 *
 * @param {string} detail
 * @param {string} target
 */
export function readIdentityFields(detail, target) {
  const fields = new Map()
  for (const line of detail.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
  }
  const teamIdentifier = fields.get('TeamIdentifier') ?? ''
  if (
    fields.get('Signature') === 'adhoc' ||
    (!fields.get('Authority') && fields.get('CodeDirectory'))
  ) {
    return { adhoc: true, teamIdentifier, authority: null }
  }
  const authority = fields.get('Authority')
  if (!authority) throw new Error(`${target} is not signed: codesign reported no Authority`)
  return { adhoc: false, teamIdentifier, authority }
}
