export type RemoteClientStatus = {
  available: boolean
  command: string | null
  platform: NodeJS.Platform
  installHint: string | null
  installHintCode?: null
  error?: string
}

export async function detectRdpClient(): Promise<RemoteClientStatus> {
  return {
    available: true,
    command: 'ola-IronRDP',
    platform: process.platform,
    installHint: null,
    installHintCode: null
  }
}
