// Regression for the agent-desktop supply-chain staging gate.
//
// `fetch:agent-desktop` downloads prebuilt binaries from a pinned archive and `--check` refuses a
// release whose staged bytes drift. Both rest on this module's lock validation and digest
// comparison, so a bug here is a build that ships whatever the archive happens to contain. These
// tests exercise the pure functions with temp fixtures only — no network, no real archive.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentDesktopEntry,
  agentDesktopPlatformKey,
  agentDesktopResourceDirName,
  inspectAgentDesktopBinaries,
  readAgentDesktopLock,
  tarCommand
} from '../../scripts/stage-agent-desktop.mjs'

const temporary: string[] = []

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

function pin(bytes: Buffer): { sha256: string; size: number } {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function lock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cli = 'ola-agent-desktop'
  const bytes = Buffer.from('binary-payload')
  return {
    version: '1.4.0',
    archiveBaseUrl: 'https://github.com/example/agent-desktop/releases/download/v1.4.0',
    platforms: {
      'darwin-arm64': {
        archive: 'agent-desktop-darwin-arm64.tar.gz',
        cli,
        binaries: { [cli]: pin(bytes), 'libax.dylib': pin(Buffer.from('dylib')) }
      }
    },
    ...overrides
  }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('agent-desktop lock validation', () => {
  it('accepts a lock that pins an https archive and names every CLI binary', async () => {
    const directory = await tempDirectory('ola-ad-lock-')
    const path = join(directory, 'lock.json')
    await writeFile(path, JSON.stringify(lock()))
    const parsed = await readAgentDesktopLock(path)
    expect(Object.keys(parsed.platforms)).toEqual(['darwin-arm64'])
  })

  it('rejects the lock shapes that would let an unpinned artifact through', async () => {
    const directory = await tempDirectory('ola-ad-lock-bad-')
    const cases: Array<{ name: string; value: unknown; message: string }> = [
      { name: 'no-platforms', value: { version: '1' }, message: 'Invalid agent-desktop lock' },
      {
        name: 'plain-http',
        value: lock({ archiveBaseUrl: 'http://github.com/x/y' }),
        message: 'must pin an https archive base URL'
      },
      {
        name: 'no-cli',
        value: lock({
          platforms: {
            'darwin-arm64': { archive: 'a.tar.gz', binaries: { other: pin(Buffer.from('x')) } }
          }
        }),
        message: 'must name its CLI binary'
      },
      {
        name: 'path-traversal',
        value: lock({
          platforms: {
            'darwin-arm64': {
              archive: '../a.tar.gz',
              cli: 'x',
              binaries: { x: pin(Buffer.from('1')) }
            }
          }
        }),
        message: 'unsafe archive name'
      },
      {
        name: 'nested-archive',
        value: lock({
          platforms: {
            'darwin-arm64': {
              archive: 'sub/a.tar.gz',
              cli: 'x',
              binaries: { x: pin(Buffer.from('1')) }
            }
          }
        }),
        message: 'unsafe archive name'
      }
    ]
    for (const testCase of cases) {
      const path = join(directory, `${testCase.name}.json`)
      await writeFile(path, JSON.stringify(testCase.value))
      await expect(readAgentDesktopLock(path)).rejects.toThrow(testCase.message)
    }
  })
})

describe('agent-desktop platform resolution', () => {
  it('keys the platform off the exact os/arch pair', () => {
    expect(agentDesktopPlatformKey('win32', 'x64')).toBe('win32-x64')
    expect(agentDesktopPlatformKey('darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('refuses a platform the lock does not publish', async () => {
    await expect(agentDesktopEntry('linux-x64', lock())).rejects.toThrow(
      'agent-desktop is not published for linux-x64'
    )
  })

  it('carries the lock version into the entry it returns', async () => {
    const entry = await agentDesktopEntry('darwin-arm64', lock())
    expect(entry).toMatchObject({ key: 'darwin-arm64', version: '1.4.0' })
    expect(entry.cli).toBe('ola-agent-desktop')
  })

  it('prefers the in-box Windows tar over whatever PATH resolves', () => {
    expect(tarCommand({}, 'darwin')).toBe('tar')
    expect(tarCommand({}, 'win32')).toBe('tar')
  })

  it('uses System32 tar.exe when the Windows root really has it', async () => {
    const directory = await tempDirectory('ola-ad-tar-')
    const system32 = join(directory, 'System32')
    await mkdir(system32, { recursive: true })
    await writeFile(join(system32, 'tar.exe'), Buffer.from(''))
    expect(tarCommand({ SystemRoot: directory }, 'win32')).toBe(join(system32, 'tar.exe'))
    expect(tarCommand({ windir: directory }, 'win32')).toBe(join(system32, 'tar.exe'))
  })
})

describe('agent-desktop staged binary inspection', () => {
  async function stage(bytes: Record<string, Buffer>): Promise<string> {
    const sourceRoot = await tempDirectory('ola-ad-stage-')
    const dir = join(sourceRoot, 'resources', agentDesktopResourceDirName, 'darwin-arm64')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(bytes)) await writeFile(join(dir, name), content)
    return sourceRoot
  }

  it('reports complete only when every pinned byte matches', async () => {
    const sourceRoot = await stage({
      'ola-agent-desktop': Buffer.from('binary-payload'),
      'libax.dylib': Buffer.from('dylib')
    })
    const inspected = await inspectAgentDesktopBinaries(sourceRoot, 'darwin-arm64', lock())
    expect(inspected.complete).toBe(true)
    expect(inspected.missing).toEqual([])
    expect(inspected.mismatched).toEqual([])
    expect(inspected.dir).toBe(
      join(sourceRoot, 'resources', agentDesktopResourceDirName, 'darwin-arm64')
    )
  })

  it('lists absent binaries instead of calling them complete', async () => {
    const sourceRoot = await stage({ 'libax.dylib': Buffer.from('dylib') })
    const inspected = await inspectAgentDesktopBinaries(sourceRoot, 'darwin-arm64', lock())
    expect(inspected.complete).toBe(false)
    expect(inspected.missing).toEqual(['ola-agent-desktop'])
  })

  it('names the drifted digest so a rebuilt artifact is diagnosable', async () => {
    const sourceRoot = await stage({
      'ola-agent-desktop': Buffer.from('silently-rebuilt'),
      'libax.dylib': Buffer.from('dylib')
    })
    const inspected = await inspectAgentDesktopBinaries(sourceRoot, 'darwin-arm64', lock())
    expect(inspected.complete).toBe(false)
    expect(inspected.missing).toEqual([])
    expect(inspected.mismatched).toHaveLength(1)
    expect(inspected.mismatched[0]).toContain('ola-agent-desktop sha256')
  })

  it('flags a pinned entry whose size changed under a matching hash', async () => {
    const bytes = Buffer.from('binary-payload')
    const drifted = lock()
    const entry = drifted.platforms as Record<string, Record<string, unknown>>
    entry['darwin-arm64'].binaries = {
      'ola-agent-desktop': { ...pin(bytes), size: bytes.length + 1 },
      'libax.dylib': pin(Buffer.from('dylib'))
    }
    const sourceRoot = await stage({
      'ola-agent-desktop': bytes,
      'libax.dylib': Buffer.from('dylib')
    })
    const inspected = await inspectAgentDesktopBinaries(sourceRoot, 'darwin-arm64', drifted)
    expect(inspected.complete).toBe(false)
    expect(inspected.mismatched).toEqual([`ola-agent-desktop size ${String(bytes.length)}`])
  })
})
