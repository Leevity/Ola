import { createConnection } from 'net'
import { spawn } from 'child_process'

export type VncDetectorPlatform = 'macos' | 'linux' | 'windows' | 'other'

export type VncClientStatus = {
  available: boolean
  command: string | null
  websockifyAvailable: boolean
  platform: VncDetectorPlatform
  installHint: string | null
  installHintCode?:
    | 'screen-sharing-unreachable'
    | 'screen-sharing-refused'
    | 'screen-sharing-no-viewer'
    | 'no-external-viewer'
    | 'embedded-bridge-only'
    | 'unsupported-platform'
    | null
}

function mapPlatform(platform: NodeJS.Platform): VncDetectorPlatform {
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  if (platform === 'win32') return 'windows'
  return 'other'
}

function probeExternalViewers(): string | null {
  const probes: ReadonlyArray<{ command: string; args: string[] }> = [
    { command: 'remmina', args: ['--version'] },
    { command: 'vncviewer', args: ['--version'] },
    { command: 'RealVNC', args: ['--version'] },
    { command: 'open', args: ['-g', 'vnc://'] }
  ]
  for (const probe of probes) {
    try {
      const child = spawn(probe.command, probe.args, { stdio: 'ignore' })
      if (child.pid) {
        child.kill()
        if (probe.command !== 'open') return probe.command
      }
    } catch {
      // Try the next viewer.
    }
  }
  return null
}

function probeTcp(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ reachable: boolean; refused: boolean }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (result: { reachable: boolean; refused: boolean }): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ reachable: true, refused: false }))
    socket.once('timeout', () => finish({ reachable: false, refused: false }))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish({ reachable: false, refused: true })
      } else {
        finish({ reachable: false, refused: false })
      }
    })
  })
}

export async function detectVncClient(host?: string, port = 5900): Promise<VncClientStatus> {
  const platform = mapPlatform(process.platform)

  if (platform === 'macos') {
    const target = host && host.trim().length > 0 ? host : '127.0.0.1'
    const probe = await probeTcp(target, port, 1500)
    if (probe.refused) {
      return {
        available: true,
        command: 'ola-noVNC',
        websockifyAvailable: true,
        platform,
        installHint:
          'macOS Screen Sharing refused the connection. Confirm the user is allowed to control the screen and that the VNC password is correct.',
        installHintCode: 'screen-sharing-refused'
      }
    }
    if (!probe.reachable) {
      return {
        available: false,
        command: null,
        websockifyAvailable: false,
        platform,
        installHint:
          'macOS Screen Sharing is not reachable on the target host. Open System Settings → General → Sharing → Screen Sharing, allow VNC viewers, confirm the firewall allows inbound TCP 5900, and make sure the Mac is awake.',
        installHintCode: 'screen-sharing-unreachable'
      }
    }
    return {
      available: true,
      command: 'ola-noVNC',
      websockifyAvailable: true,
      platform,
      installHint:
        'macOS Screen Sharing is reachable, but the built-in service speaks RFB over TCP only. Ola bridges it through a local WebSocket; if the bridge fails, enable websockify or use a vnc:// viewer.',
      installHintCode: 'embedded-bridge-only'
    }
  }

  if (platform === 'linux' || platform === 'windows') {
    const command = probeExternalViewers()
    if (command) {
      return {
        available: true,
        command,
        websockifyAvailable: false,
        platform,
        installHint: null,
        installHintCode: null
      }
    }
    return {
      available: false,
      command: null,
      websockifyAvailable: false,
      platform,
      installHint:
        'No external VNC viewer was detected. Install Remmina, TigerVNC, RealVNC, or any client compatible with vnc:// URIs.',
      installHintCode: 'no-external-viewer'
    }
  }

  return {
    available: false,
    command: null,
    websockifyAvailable: false,
    platform: 'other',
    installHint: 'VNC remote control is not supported on this platform.',
    installHintCode: 'unsupported-platform'
  }
}
