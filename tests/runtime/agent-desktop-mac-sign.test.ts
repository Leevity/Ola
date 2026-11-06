import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  readMachOArchitectures,
  containsArchitecture,
  readIdentityFields,
  readBundleArchitectures,
  agentDesktopBundleKey,
  signAgentDesktopBinaries,
  verifyAgentDesktopSignatures
} from '../../scripts/agent-desktop-mac-sign.mjs'
import { agentDesktopPlatformKey } from '../../scripts/stage-agent-desktop.mjs'

const MH_MAGIC_64 = 0xfeedfacf
const CPU_X64 = 0x01000007
const CPU_ARM64 = 0x0100000c
const temporary: string[] = []

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop() as string, { recursive: true, force: true })
})

/** @param {number} cputype */
function thinHeader(cputype: number): Buffer {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(MH_MAGIC_64, 0)
  bytes.writeUInt32LE(cputype, 4)
  return bytes
}

function fatHeader(arches: number[]): Buffer {
  const bytes = Buffer.alloc(8 + arches.length * 20)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(arches.length, 4)
  arches.forEach((cputype, index) => bytes.writeUInt32BE(cputype, 8 + index * 20))
  return bytes
}

describe('Mach-O architecture reading', () => {
  it('reads a little-endian thin header', () => {
    expect(readMachOArchitectures(thinHeader(CPU_ARM64))).toEqual(['arm64'])
    expect(readMachOArchitectures(thinHeader(CPU_X64))).toEqual(['x64'])
  })

  it('reads every slice of a fat binary', () => {
    expect(readMachOArchitectures(fatHeader([CPU_ARM64, CPU_X64]))).toEqual(['arm64', 'x64'])
    expect(containsArchitecture(fatHeader([CPU_ARM64, CPU_X64]), 'x64')).toBe(true)
  })

  it('refuses anything that is not a supported 64-bit Mach-O', () => {
    const script = Buffer.alloc(64)
    script.write('#!/bin/sh')
    expect(() => readMachOArchitectures(script)).toThrow(/unknown magic/)
    // i386 shares the x86 cpu type without the 64-bit flag; shipping it would be a silent downgrade.
    expect(() => readMachOArchitectures(thinHeader(0x00000007))).toThrow(/unsupported Mach-O/)
    expect(() => readMachOArchitectures(Buffer.alloc(2))).toThrow(/shorter than a header/)
  })

  it('rejects a truncated fat table', () => {
    const bytes = Buffer.alloc(16)
    bytes.writeUInt32BE(0xcafebabe, 0)
    bytes.writeUInt32BE(4, 4)
    expect(() => readMachOArchitectures(bytes)).toThrow(/truncated fat/)
  })
})

describe('codesign identity reading', () => {
  it('separates an ad-hoc signature from a real one', () => {
    expect(
      readIdentityFields(
        'CodeDirectory v=20400 size=98\nSignature=adhoc\nTeamIdentifier=not set',
        'x'
      )
    ).toEqual({ adhoc: true, teamIdentifier: 'not set', authority: null })
    const real = readIdentityFields(
      'Identifier=com.ola.app\nAuthority=Developer ID Application: Ola (TEAM123)\nTeamIdentifier=TEAM123',
      'x'
    )
    expect(real.adhoc).toBe(false)
    expect(real.teamIdentifier).toBe('TEAM123')
  })

  it('treats a file with no signature record as unsigned', () => {
    expect(() => readIdentityFields('CdInfo=0\nResourceDirectory=', '/x')).toThrow(/is not signed/)
  })
})

/** Build a bundle that claims `arch` and carries the binaries the lock pins for it. */
async function fakeBundle(
  arch: 'arm64' | 'x64',
  options: { omitHelper?: boolean } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ola-agent-desktop-sign-'))
  temporary.push(root)
  const appPath = join(root, 'Ola.app')
  const cputype = arch === 'arm64' ? CPU_ARM64 : CPU_X64
  const executable = join(appPath, 'Contents', 'MacOS')
  mkdirSync(executable, { recursive: true })
  writeFileSync(join(executable, 'Ola'), thinHeader(cputype))
  const directory = join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'resources',
    'agent-desktop',
    agentDesktopPlatformKey('darwin', arch)
  )
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'agent-desktop'), thinHeader(cputype))
  if (!options.omitHelper)
    writeFileSync(join(directory, 'agent-desktop-macos-helper'), thinHeader(cputype))
  return appPath
}

describe('bundled binary signing rules', () => {
  it('resolves the triple from the executable the bundle ships', async () => {
    const appPath = await fakeBundle('x64')
    expect(await readBundleArchitectures({ appPath, executable: 'Ola' })).toEqual(['x64'])
    expect(await agentDesktopBundleKey({ appPath, executable: 'Ola', platform: 'darwin' })).toEqual(
      {
        key: 'darwin-x64',
        architecture: 'x64'
      }
    )
  })

  it('signs every binary the lock pins, ad-hoc without a timestamp', async () => {
    const appPath = await fakeBundle('arm64')
    const calls: string[][] = []
    const files = await signAgentDesktopBinaries({
      appPath,
      executable: 'Ola',
      platform: 'darwin',
      codesign: async (args) => {
        calls.push(args)
        return ''
      }
    })
    expect(files).toEqual([
      join(
        appPath,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'resources',
        'agent-desktop',
        'darwin-arm64',
        'agent-desktop'
      ),
      join(
        appPath,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'resources',
        'agent-desktop',
        'darwin-arm64',
        'agent-desktop-macos-helper'
      )
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('--timestamp=none')
    expect(calls[0]).not.toContain('--options')
  })

  it('requires a timestamp and hardened runtime under a real identity', async () => {
    const appPath = await fakeBundle('arm64')
    const calls: string[][] = []
    await signAgentDesktopBinaries({
      appPath,
      executable: 'Ola',
      platform: 'darwin',
      identity: 'Developer ID Application: Ola (TEAM123)',
      codesign: async (args) => {
        calls.push(args)
        return ''
      }
    })
    expect(calls[0]).toContain('--timestamp')
    expect(calls[0]).toContain('--options')
    expect(calls[0]).toContain('runtime')
  })

  it('refuses to sign a helper built for another architecture', async () => {
    const appPath = await fakeBundle('arm64')
    const helper = join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'resources',
      'agent-desktop',
      'darwin-arm64',
      'agent-desktop-macos-helper'
    )
    writeFileSync(helper, thinHeader(CPU_X64))
    await expect(
      signAgentDesktopBinaries({
        appPath,
        executable: 'Ola',
        platform: 'darwin',
        codesign: async () => ''
      })
    ).rejects.toThrow(/is not an arm64 Mach-O/)
  })

  it('fails closed when a pinned binary is absent from the bundle', async () => {
    const appPath = await fakeBundle('arm64', { omitHelper: true })
    await expect(
      verifyAgentDesktopSignatures({
        appPath,
        executable: 'Ola',
        platform: 'darwin',
        codesign: async () => ''
      })
    ).rejects.toThrow(/npm run fetch:agent-desktop/)
  })

  it('reports an unsigned release binary instead of shipping it', async () => {
    const appPath = await fakeBundle('arm64')
    await expect(
      verifyAgentDesktopSignatures({
        appPath,
        executable: 'Ola',
        platform: 'darwin',
        requireSignature: true,
        codesign: async (args) =>
          String(args[1]).endsWith('MacOS/Ola')
            ? 'Authority=Developer ID Application: Ola (TEAM123)\nTeamIdentifier=TEAM123\n'
            : 'CdInfo=0\nResourceDirectory=\n'
      })
    ).rejects.toThrow(/is not signed/)
  })

  it('refuses an ad-hoc binary inside a signed release', async () => {
    const appPath = await fakeBundle('arm64')
    await expect(
      verifyAgentDesktopSignatures({
        appPath,
        executable: 'Ola',
        platform: 'darwin',
        requireSignature: true,
        codesign: async (args) =>
          String(args[1]).endsWith('MacOS/Ola')
            ? 'Authority=Developer ID Application: Ola (TEAM123)\nTeamIdentifier=TEAM123\n'
            : 'CodeDirectory v=20400 size=98\nSignature=adhoc\nTeamIdentifier=not set\n'
      })
    ).rejects.toThrow(/only ad-hoc signed/)
  })

  it('refuses a helper signed by a different team', async () => {
    const appPath = await fakeBundle('arm64')
    await expect(
      verifyAgentDesktopSignatures({
        appPath,
        executable: 'Ola',
        platform: 'darwin',
        requireSignature: true,
        codesign: async (args) =>
          String(args[1]).endsWith('MacOS/Ola')
            ? 'Authority=Developer ID Application: Ola (TEAM123)\nTeamIdentifier=TEAM123\n'
            : 'Authority=Developer ID Application: Someone Else (OTHERTEAM)\nTeamIdentifier=OTHERTEAM\n'
      })
    ).rejects.toThrow(/but the app is TEAM123/)
  })

  it('passes a release whose helpers match the app identity', async () => {
    const appPath = await fakeBundle('arm64')
    const detail = 'Authority=Developer ID Application: Ola (TEAM123)\nTeamIdentifier=TEAM123\n'
    expect(
      await verifyAgentDesktopSignatures({
        appPath,
        executable: 'Ola',
        platform: 'darwin',
        requireSignature: true,
        codesign: async () => detail
      })
    ).toHaveLength(2)
  })
})

// The host cannot sign something that is not a real Mach-O, so this case runs `codesign` against
// copies of the interpreter itself: same rules, same ad-hoc identity a CI bundle gets.
const realSigning =
  process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) ? it : it.skip

describe('bundled binary signing against the real codesign', () => {
  realSigning('signs and re-reads the architectures of actual Mach-O files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-agent-desktop-codesign-'))
    temporary.push(root)
    const appPath = join(root, 'Ola.app')
    const executable = join(appPath, 'Contents', 'MacOS')
    mkdirSync(executable, { recursive: true })
    const node = readFileSync(process.execPath)
    writeFileSync(join(executable, 'Ola'), node)
    chmodSync(join(executable, 'Ola'), 0o755)
    const directory = join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'resources',
      'agent-desktop',
      agentDesktopPlatformKey('darwin', process.arch)
    )
    mkdirSync(directory, { recursive: true })
    for (const name of ['agent-desktop', 'agent-desktop-macos-helper']) {
      writeFileSync(join(directory, name), node)
      chmodSync(join(directory, name), 0o755)
    }

    const files = await signAgentDesktopBinaries({ appPath, executable: 'Ola' })
    expect(files).toHaveLength(2)
    // An ad-hoc bundle is the expected state for an unsigned build, so the architecture rule is the
    // part that must hold without a certificate.
    expect(
      await verifyAgentDesktopSignatures({ appPath, executable: 'Ola', requireSignature: false })
    ).toHaveLength(2)
    await expect(
      verifyAgentDesktopSignatures({ appPath, executable: 'Ola', requireSignature: true })
    ).rejects.toThrow(/only ad-hoc signed/)
  })
})
