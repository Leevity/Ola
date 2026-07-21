import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export type RemoteCaptureProbeStatus = 'idle' | 'requesting' | 'capturing' | 'error'
export type RemoteCaptureSource = {
  id: string
  name: string
  displayId: string
  primary: boolean
}

type RemoteCaptureStore = {
  status: RemoteCaptureProbeStatus
  error: string | null
  label: string | null
  width: number | null
  height: number | null
  startedAt: number | null
  sources: RemoteCaptureSource[]
  selectedSourceId: string | null
  displayId: string | null
  loadSources: () => Promise<void>
  selectSource: (sourceId: string) => void
  stop: () => void
  startProbe: () => Promise<void>
}

let captureStream: MediaStream | null = null

export function getRemoteCaptureStream(): MediaStream | null {
  return captureStream
}

export function getRemoteCaptureDisplayId(): string | null {
  return useRemoteCaptureStore.getState().displayId
}

async function fetchCaptureSources(): Promise<RemoteCaptureSource[]> {
  const result = (await ipcClient.invoke(IPC.REMOTE_CAPTURE_SOURCES)) as {
    sources: RemoteCaptureSource[]
  }
  return result.sources
}

function stopStream(): void {
  captureStream?.getTracks().forEach((track) => track.stop())
  captureStream = null
}

export const useRemoteCaptureStore = create<RemoteCaptureStore>((set) => ({
  status: 'idle',
  error: null,
  label: null,
  width: null,
  height: null,
  startedAt: null,
  sources: [],
  selectedSourceId: null,
  displayId: null,
  loadSources: async () => {
    const sources = await fetchCaptureSources()
    const current = useRemoteCaptureStore.getState().selectedSourceId
    const selected =
      sources.find((source) => source.id === current) ??
      sources.find((source) => source.primary) ??
      sources[0] ??
      null
    set({ sources, selectedSourceId: selected?.id ?? null })
  },
  selectSource: (sourceId) => {
    const source = useRemoteCaptureStore.getState().sources.find((item) => item.id === sourceId)
    if (source) set({ selectedSourceId: source.id })
  },
  stop: () => {
    stopStream()
    set({
      status: 'idle',
      error: null,
      label: null,
      width: null,
      height: null,
      startedAt: null,
      displayId: null
    })
  },
  startProbe: async () => {
    stopStream()
    set({
      status: 'requesting',
      error: null,
      label: null,
      width: null,
      height: null,
      startedAt: null
    })
    try {
      const permission = (await ipcClient.invoke(IPC.REMOTE_CAPTURE_PERMISSION)) as {
        status: string
      }
      if (permission.status === 'denied' || permission.status === 'restricted') {
        throw new Error(
          'Screen Recording permission is required. Enable Ola in System Settings > Privacy & Security > Screen Recording, then restart Ola.'
        )
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Desktop capture is not available in this renderer')
      }
      const sources = await fetchCaptureSources()
      const current = useRemoteCaptureStore.getState().selectedSourceId
      const source =
        sources.find((item) => item.id === current) ??
        sources.find((item) => item.primary) ??
        sources[0]
      if (!source) throw new Error('No screen capture source is available')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id
          }
        } as MediaTrackConstraints,
        audio: false
      })
      captureStream = stream
      const [track] = stream.getVideoTracks()
      if (!track) throw new Error('No video track was returned')
      const settings = track.getSettings()
      track.onended = () => {
        captureStream = null
        set({ status: 'idle' })
      }
      set({
        status: 'capturing',
        error: null,
        label: track.label || 'Screen capture track',
        width: settings.width ?? null,
        height: settings.height ?? null,
        startedAt: Date.now(),
        sources,
        selectedSourceId: source.id,
        displayId: source.displayId
      })
    } catch (error) {
      stopStream()
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        label: null,
        width: null,
        height: null,
        startedAt: null,
        displayId: null
      })
      throw error
    }
  }
}))
