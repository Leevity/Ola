export type VncClientStatus = {
  available: boolean
  command: string | null
  websockifyAvailable: boolean
  platform: NodeJS.Platform
  installHint: string | null
  installHintCode?: null
}

export async function detectVncClient(): Promise<VncClientStatus> {
  return {
    available: true,
    command: 'ola-noVNC',
    websockifyAvailable: true,
    platform: process.platform,
    installHint: null,
    installHintCode: null
  }
}
