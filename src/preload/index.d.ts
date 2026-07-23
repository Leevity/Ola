import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs,
  TeamRuntimeCreateResult,
  TeamRuntimeMessageRecord,
  TeamRuntimeSnapshot
} from '../shared/team-runtime-types'

interface OlaIpcBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  removeAllListeners: (channel: string) => void
}

interface OlaAPI {
  downloadImage: (args: {
    url: string
    defaultName?: string
  }) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string; error?: string }>
  fetchImageBase64: (args: {
    url: string
  }) => Promise<{ data?: string; mimeType?: string; error?: string }>
  writeImageToClipboard: (args: { data: string }) => Promise<{ success?: boolean; error?: string }>
  teamRuntimeCreate: (args: CreateTeamRuntimeArgs) => Promise<TeamRuntimeCreateResult>
  teamRuntimeDelete: (args: DeleteTeamRuntimeArgs) => Promise<{ success: true }>
  teamRuntimeAppendMessage: (args: AppendTeamRuntimeMessageArgs) => Promise<{ success: true }>
  teamRuntimeGetSnapshot: (args: GetTeamRuntimeSnapshotArgs) => Promise<TeamRuntimeSnapshot | null>
  teamRuntimeUpdateMember: (args: UpdateTeamRuntimeMemberArgs) => Promise<{ success: true }>
  teamRuntimeUpdateManifest: (args: UpdateTeamRuntimeManifestArgs) => Promise<{ success: true }>
  teamRuntimeConsumeMessages: (
    args: ConsumeTeamRuntimeMessagesArgs
  ) => Promise<TeamRuntimeMessageRecord[]>
}

interface OlaBridge {
  ipc: OlaIpcBridge
  media: Pick<OlaAPI, 'downloadImage' | 'fetchImageBase64' | 'writeImageToClipboard'>
  teamRuntime: {
    create: OlaAPI['teamRuntimeCreate']
    delete: OlaAPI['teamRuntimeDelete']
    appendMessage: OlaAPI['teamRuntimeAppendMessage']
    getSnapshot: OlaAPI['teamRuntimeGetSnapshot']
    updateMember: OlaAPI['teamRuntimeUpdateMember']
    updateManifest: OlaAPI['teamRuntimeUpdateManifest']
    consumeMessages: OlaAPI['teamRuntimeConsumeMessages']
  }
}

declare global {
  interface Window {
    ola: OlaBridge
    electron: ElectronAPI
    api: OlaAPI
  }
}
