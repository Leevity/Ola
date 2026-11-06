import { constants as fsConstants, accessSync, existsSync } from 'node:fs'
import { release } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'

const agentDesktopResourceDirName = 'agent-desktop'

export type AgentDesktopPlatform = 'macos' | 'linux' | 'windows' | 'other'
export type AgentDesktopBackend = 'ax' | 'uia' | 'atspi-x11' | 'atspi-wayland' | null
export type AgentDesktopPermission = 'granted' | 'denied' | 'unknown'
export type AgentDesktopInstallHintCode =
  | 'binary-missing'
  | 'binary-not-executable'
  | 'accessibility-permission'
  | 'macos-version-too-old'
  | 'windows-build-too-old'
  | 'wayland-unsupported'
  | 'no-display-server'
  | 'no-dbus-session'
  | 'unsupported-platform'
  | null

export type AgentDesktopStatus = {
  available: boolean
  platform: AgentDesktopPlatform
  backend: AgentDesktopBackend
  binaryPath: string | null
  accessibility: AgentDesktopPermission
  installHint: string | null
  installHintCode: AgentDesktopInstallHintCode
}

export type AgentDesktopPermissionProbe = {
  accessibility?: string
}

export type AgentDesktopDetectInput = {
  platform: NodeJS.Platform
  osRelease: string
  env: NodeJS.ProcessEnv
  binaryPath: string | null
  binaryExecutable: boolean
  permissions?: AgentDesktopPermissionProbe
}

// Darwin 22 is macOS 13 Ventura; Windows build 17763 is 1809. Both floors come from
// upstream's supported-platform table, not from what happens to work today.
const MIN_MACOS_DARWIN_MAJOR = 22
const MIN_WINDOWS_BUILD = 17763

export function mapAgentDesktopPlatform(platform: NodeJS.Platform): AgentDesktopPlatform {
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  if (platform === 'win32') return 'windows'
  return 'other'
}

export function agentDesktopBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop'
}

export function agentDesktopTripleKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`
}

/** Test builds point this at a fake CLI; production leaves it unset and uses the packaged tree. */
export const AGENT_DESKTOP_BIN_ENV = 'OLA_AGENT_DESKTOP_BIN'

export function resolveAgentDesktopBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const override = env[AGENT_DESKTOP_BIN_ENV]?.trim()
  if (override) {
    const candidate = isAbsolute(override) ? override : resolve(override)
    return existsSync(candidate) ? candidate : null
  }
  const key = agentDesktopTripleKey(platform, arch)
  for (const dir of getBundledResourceDirCandidates('agent-desktop')) {
    const candidate = join(dir, key, agentDesktopBinaryName(platform))
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Only a binary Ola shipped itself is hash-pinned at run time. `OLA_AGENT_DESKTOP_BIN` exists for
 * contract tests and local experiments, where the file is deliberately not the pinned build.
 */
export function isPinnedAgentDesktopBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  const override = env[AGENT_DESKTOP_BIN_ENV]?.trim()
  if (override) return false
  return binaryPath.includes(
    join(agentDesktopResourceDirName, agentDesktopTripleKey(platform, arch))
  )
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  if (!path) return false
  if (platform === 'win32') return existsSync(path)
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function parseLeadingNumber(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function permissionFromProbe(probe?: AgentDesktopPermissionProbe): AgentDesktopPermission {
  const state = probe?.accessibility?.trim().toLowerCase()
  if (state === 'granted' || state === 'allowed') return 'granted'
  if (state === 'denied' || state === 'not_granted') return 'denied'
  return 'unknown'
}

function buildStatus(
  input: AgentDesktopDetectInput,
  available: boolean,
  backend: AgentDesktopBackend,
  installHintCode: AgentDesktopInstallHintCode,
  installHint: string | null,
  accessibility: AgentDesktopPermission
): AgentDesktopStatus {
  return {
    available,
    platform: mapAgentDesktopPlatform(input.platform),
    backend,
    binaryPath: input.binaryPath,
    accessibility,
    installHint,
    installHintCode
  }
}

/**
 * Pure capability gate. It answers "can this platform run headless accessibility actions at
 * all", which is a different question from "is the user allowed" — that answer comes from the
 * CLI's own permission probe and, at run time, from a PERM_DENIED envelope.
 */
export function detectAgentDesktop(input: AgentDesktopDetectInput): AgentDesktopStatus {
  const accessibility = permissionFromProbe(input.permissions)
  const platform = mapAgentDesktopPlatform(input.platform)

  if (!input.binaryPath) {
    return buildStatus(
      input,
      false,
      null,
      'binary-missing',
      'Run `npm run fetch:agent-desktop` to stage the pinned agent-desktop binary for this platform.',
      accessibility
    )
  }
  if (!input.binaryExecutable) {
    return buildStatus(
      input,
      false,
      null,
      'binary-not-executable',
      'The staged agent-desktop binary is not executable. Re-run `npm run fetch:agent-desktop`.',
      accessibility
    )
  }

  if (platform === 'other') {
    return buildStatus(
      input,
      false,
      null,
      'unsupported-platform',
      'Accessibility desktop control is supported on macOS, Windows and Linux only.',
      accessibility
    )
  }

  if (platform === 'macos') {
    if (parseLeadingNumber(input.osRelease) < MIN_MACOS_DARWIN_MAJOR) {
      return buildStatus(
        input,
        false,
        'ax',
        'macos-version-too-old',
        'Ola needs macOS 13 or later for accessibility-based desktop control.',
        accessibility
      )
    }
    if (accessibility === 'denied') {
      return buildStatus(
        input,
        false,
        'ax',
        'accessibility-permission',
        'macOS has not granted Accessibility access to Ola. Open System Settings → Privacy & Security → Accessibility and enable Ola, then relaunch.',
        accessibility
      )
    }
    return buildStatus(input, true, 'ax', null, null, accessibility)
  }

  if (platform === 'windows') {
    const parts = input.osRelease.split('.')
    const build = parseLeadingNumber(parts[2])
    if (build < MIN_WINDOWS_BUILD) {
      return buildStatus(
        input,
        false,
        'uia',
        'windows-build-too-old',
        'Ola needs Windows 10 1809 or later for accessibility-based desktop control.',
        accessibility
      )
    }
    return buildStatus(input, true, 'uia', null, null, accessibility)
  }

  const sessionType = input.env.XDG_SESSION_TYPE?.trim().toLowerCase()
  const hasWayland = Boolean(input.env.WAYLAND_DISPLAY?.trim())
  const hasX11 = Boolean(input.env.DISPLAY?.trim())
  if ((sessionType === 'wayland' || hasWayland) && !hasX11) {
    return buildStatus(
      input,
      false,
      'atspi-wayland',
      'wayland-unsupported',
      'Wayland sessions are not supported for accessibility desktop control because window focus and pointer input are refused by the compositor. Start the session in the X11 ("Xorg") option, or install xdg-desktop-portal with XWayland exposure enabled.',
      accessibility
    )
  }
  if (!hasX11 && !hasWayland) {
    return buildStatus(
      input,
      false,
      null,
      'no-display-server',
      'No DISPLAY or WAYLAND_DISPLAY is set, so there is no desktop session to control. Ola must run inside the graphical session.',
      accessibility
    )
  }
  if (!input.env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    return buildStatus(
      input,
      false,
      'atspi-x11',
      'no-dbus-session',
      'AT-SPI needs DBUS_SESSION_BUS_ADDRESS. Launch Ola from the desktop session, not from a bare SSH shell.',
      accessibility
    )
  }
  return buildStatus(input, true, 'atspi-x11', null, null, accessibility)
}

/** Read the live environment and return the capability gate for this machine. */
export function probeAgentDesktop(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  permissions?: AgentDesktopPermissionProbe
): AgentDesktopStatus {
  const binaryPath = resolveAgentDesktopBinary(env, platform, arch)
  return detectAgentDesktop({
    platform,
    osRelease: release(),
    env,
    binaryPath,
    binaryExecutable: binaryPath ? isExecutable(binaryPath, platform) : false,
    permissions
  })
}
