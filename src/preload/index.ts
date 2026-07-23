import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../shared/team-runtime-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../shared/messagepack/binary-ipc'

async function invokeMessagePackBinary<T>(channel: string, payload: unknown): Promise<T> {
  const response = await ipcRenderer.invoke(
    toMessagePackChannel(channel),
    encodeMessagePackPayload(payload)
  )
  return decodeMessagePackPayload<T>(response as ArrayBuffer | ArrayBufferView)
}

const olaIpc = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const handler = (_event: unknown, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel)
}

// Legacy custom APIs for renderer. New callers should use window.ola by domain.
const api = {
  downloadImage: (args: { url: string; defaultName?: string }) =>
    invokeMessagePackBinary('image:download', args),
  fetchImageBase64: (args: { url: string }) => invokeMessagePackBinary('image:fetch-base64', args),
  writeImageToClipboard: (args: { data: string }) =>
    invokeMessagePackBinary('clipboard:write-image', args),
  teamRuntimeCreate: (args: CreateTeamRuntimeArgs) =>
    invokeMessagePackBinary('team-runtime:create', args),
  teamRuntimeDelete: (args: DeleteTeamRuntimeArgs) =>
    invokeMessagePackBinary('team-runtime:delete', args),
  teamRuntimeAppendMessage: (args: AppendTeamRuntimeMessageArgs) =>
    invokeMessagePackBinary('team-runtime:message:append', args),
  teamRuntimeGetSnapshot: (args: GetTeamRuntimeSnapshotArgs) =>
    invokeMessagePackBinary('team-runtime:snapshot', args),
  teamRuntimeUpdateMember: (args: UpdateTeamRuntimeMemberArgs) =>
    invokeMessagePackBinary('team-runtime:member:update', args),
  teamRuntimeUpdateManifest: (args: UpdateTeamRuntimeManifestArgs) =>
    invokeMessagePackBinary('team-runtime:manifest:update', args),
  teamRuntimeConsumeMessages: (args: ConsumeTeamRuntimeMessagesArgs) =>
    invokeMessagePackBinary('team-runtime:messages:consume', args)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
const ola = {
  ipc: olaIpc,
  media: {
    downloadImage: api.downloadImage,
    fetchImageBase64: api.fetchImageBase64,
    writeImageToClipboard: api.writeImageToClipboard
  },
  teamRuntime: {
    create: api.teamRuntimeCreate,
    delete: api.teamRuntimeDelete,
    appendMessage: api.teamRuntimeAppendMessage,
    getSnapshot: api.teamRuntimeGetSnapshot,
    updateMember: api.teamRuntimeUpdateMember,
    updateManifest: api.teamRuntimeUpdateManifest,
    consumeMessages: api.teamRuntimeConsumeMessages
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('ola', ola)
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.ola = ola
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
