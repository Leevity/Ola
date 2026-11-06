import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentDesktopBinaryName,
  detectAgentDesktop,
  probeAgentDesktop,
  resolveAgentDesktopBinary,
  type AgentDesktopDetectInput
} from '../../src/main/agent-desktop/detector'

const cleanup: string[] = []

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

function base(overrides: Partial<AgentDesktopDetectInput>): AgentDesktopDetectInput {
  return {
    platform: 'linux',
    osRelease: '6.8.0-40-generic',
    env: { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    binaryPath: '/opt/ola/resources/agent-desktop/linux-x64/agent-desktop',
    binaryExecutable: true,
    ...overrides
  }
}

describe('agent-desktop capability detector', () => {
  it('reports the macOS AX backend once Accessibility is granted', () => {
    const status = detectAgentDesktop(
      base({
        platform: 'darwin',
        osRelease: '24.1.0',
        binaryPath: '/app/Contents/Resources/agent-desktop/darwin-arm64/agent-desktop',
        permissions: { accessibility: 'granted' }
      })
    )
    expect(status).toMatchObject({
      available: true,
      platform: 'macos',
      backend: 'ax',
      accessibility: 'granted',
      installHintCode: null
    })
  })

  it('stays unavailable while macOS Accessibility is denied and names the fix', () => {
    const status = detectAgentDesktop(
      base({
        platform: 'darwin',
        osRelease: '24.1.0',
        permissions: { accessibility: 'denied' }
      })
    )
    expect(status.available).toBe(false)
    expect(status.installHintCode).toBe('accessibility-permission')
    expect(status.installHint).toMatch(/Accessibility/)
  })

  it('refuses macOS releases below the supported floor', () => {
    const status = detectAgentDesktop(
      base({
        platform: 'darwin',
        osRelease: '21.6.0',
        permissions: { accessibility: 'granted' }
      })
    )
    expect(status.installHintCode).toBe('macos-version-too-old')
    expect(status.available).toBe(false)
  })

  it.each([
    ['10.0.19045', true],
    ['10.0.17763', true],
    ['10.0.17762', false],
    ['6.3.9600', false]
  ])('maps Windows %s to availability %s', (osRelease, available) => {
    const status = detectAgentDesktop(
      base({
        platform: 'win32',
        osRelease,
        binaryPath: 'C:\\app\\resources\\agent-desktop\\win32-x64\\agent-desktop.exe'
      })
    )
    expect(status.platform).toBe('windows')
    expect(status.backend).toBe('uia')
    expect(status.available).toBe(available)
    if (!available) expect(status.installHintCode).toBe('windows-build-too-old')
  })

  it('accepts an X11 session that exposes the AT-SPI bus', () => {
    const status = detectAgentDesktop(base({}))
    expect(status).toMatchObject({
      available: true,
      platform: 'linux',
      backend: 'atspi-x11',
      installHintCode: null
    })
  })

  it('does not report Wayland as available just because the binary staged', () => {
    const status = detectAgentDesktop(
      base({
        env: {
          XDG_SESSION_TYPE: 'wayland',
          WAYLAND_DISPLAY: 'wayland-0',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
        }
      })
    )
    expect(status.available).toBe(false)
    expect(status.backend).toBe('atspi-wayland')
    expect(status.installHintCode).toBe('wayland-unsupported')
    expect(status.installHint).toMatch(/X11/)
  })

  it('requires a display server of any kind', () => {
    const status = detectAgentDesktop(base({ env: {} }))
    expect(status.available).toBe(false)
    expect(status.installHintCode).toBe('no-display-server')
  })

  it('requires a session bus for AT-SPI', () => {
    const status = detectAgentDesktop(base({ env: { DISPLAY: ':0' } }))
    expect(status.available).toBe(false)
    expect(status.installHintCode).toBe('no-dbus-session')
  })

  it('fails closed on an unsupported platform', () => {
    const status = detectAgentDesktop(base({ platform: 'freebsd' }))
    expect(status).toMatchObject({
      available: false,
      platform: 'other',
      backend: null,
      installHintCode: 'unsupported-platform'
    })
  })

  it('prefers a missing or non-executable binary over every platform gate', () => {
    expect(
      detectAgentDesktop(base({ binaryPath: null })).installHintCode,
      'binary-missing is the first refusal'
    ).toBe('binary-missing')
    expect(
      detectAgentDesktop(
        base({
          platform: 'darwin',
          osRelease: '21.6.0',
          binaryExecutable: false
        })
      ).installHintCode
    ).toBe('binary-not-executable')
  })

  it('always pairs an unavailable result with user-facing guidance', () => {
    const cases = [
      base({ binaryPath: null }),
      base({ platform: 'freebsd' }),
      base({ env: {} }),
      base({ platform: 'darwin', osRelease: '24.1.0', permissions: { accessibility: 'denied' } }),
      base({ platform: 'win32', osRelease: '10.0.10586' })
    ]
    for (const input of cases) {
      const status = detectAgentDesktop(input)
      if (status.available) continue
      expect(status.installHint, `${status.installHintCode} needs a hint`).toBeTruthy()
      expect(status.installHintCode, 'every refusal is codeable').toBeTruthy()
    }
  })

  it('resolves the OLA_AGENT_DESKTOP_BIN override ahead of the packaged tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-agent-desktop-bin-'))
    cleanup.push(directory)
    const fake = join(directory, 'agent-desktop')
    await writeFile(fake, '#!/bin/sh\nexit 0\n')
    await chmod(fake, 0o755)
    expect(resolveAgentDesktopBinary({ OLA_AGENT_DESKTOP_BIN: fake })).toBe(fake)
    expect(
      resolveAgentDesktopBinary({ OLA_AGENT_DESKTOP_BIN: join(directory, 'absent') })
    ).toBeNull()
  })

  it('names the platform-specific executable', () => {
    expect(agentDesktopBinaryName('win32')).toBe('agent-desktop.exe')
    expect(agentDesktopBinaryName('darwin')).toBe('agent-desktop')
    expect(agentDesktopBinaryName('linux')).toBe('agent-desktop')
  })

  const hostBinary = resolveAgentDesktopBinary({})
  it.runIf(Boolean(hostBinary))(
    'probes this machine without inventing an availability claim',
    () => {
      const status = probeAgentDesktop()
      expect(status.binaryPath).toContain(
        join('agent-desktop', `${process.platform}-${process.arch}`)
      )
      expect(status.platform).not.toBe('other')
      if (!status.available) {
        expect(
          status.installHint,
          'a refusal on a real machine must still explain itself'
        ).toBeTruthy()
        expect(status.installHintCode).toBeTruthy()
      } else {
        expect(['ax', 'uia', 'atspi-x11']).toContain(status.backend)
      }
    }
  )

  it('pins the host triple with a full-length sha256 per binary', () => {
    const lock = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../resources/agent-desktop.lock.json'), 'utf8')
    ) as {
      version: string
      platforms: Record<
        string,
        { cli: string; binaries: Record<string, { sha256: string; size: number }> }
      >
    }
    const entry = lock.platforms[`${process.platform}-${process.arch}`]
    expect(entry, `lock must pin ${process.platform}-${process.arch}`).toBeTruthy()
    expect(entry.cli).toBe(agentDesktopBinaryName(process.platform))
    for (const pin of Object.values(entry.binaries)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.size).toBeGreaterThan(0)
    }
  })
})
