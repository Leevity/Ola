import { create } from 'zustand'

export type RemoteWebRtcProbeStatus = 'idle' | 'running' | 'connected' | 'error'

type RemoteWebRtcStore = {
  status: RemoteWebRtcProbeStatus
  error: string | null
  lastMessage: string | null
  startedAt: number | null
  completedAt: number | null
  runLocalProbe: () => Promise<void>
  reset: () => void
}

let localPeer: RTCPeerConnection | null = null
let remotePeer: RTCPeerConnection | null = null
let dataChannel: RTCDataChannel | null = null

function cleanup(): void {
  dataChannel?.close()
  localPeer?.close()
  remotePeer?.close()
  dataChannel = null
  localPeer = null
  remotePeer = null
}

export const useRemoteWebRtcStore = create<RemoteWebRtcStore>((set) => ({
  status: 'idle',
  error: null,
  lastMessage: null,
  startedAt: null,
  completedAt: null,
  runLocalProbe: async () => {
    cleanup()
    const startedAt = Date.now()
    set({ status: 'running', error: null, lastMessage: null, startedAt, completedAt: null })
    try {
      localPeer = new RTCPeerConnection({ iceServers: [] })
      remotePeer = new RTCPeerConnection({ iceServers: [] })

      localPeer.onicecandidate = (event) => {
        if (event.candidate) void remotePeer?.addIceCandidate(event.candidate)
      }
      remotePeer.onicecandidate = (event) => {
        if (event.candidate) void localPeer?.addIceCandidate(event.candidate)
      }

      const opened = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('WebRTC probe timed out')), 5000)
        remotePeer!.ondatachannel = (event) => {
          const channel = event.channel
          channel.onmessage = (messageEvent) => {
            set({
              status: 'connected',
              lastMessage: String(messageEvent.data),
              completedAt: Date.now()
            })
            window.clearTimeout(timeout)
            resolve()
          }
        }
      })

      dataChannel = localPeer.createDataChannel('control')
      const offer = await localPeer.createOffer()
      await localPeer.setLocalDescription(offer)
      await remotePeer.setRemoteDescription(offer)
      const answer = await remotePeer.createAnswer()
      await remotePeer.setLocalDescription(answer)
      await localPeer.setRemoteDescription(answer)

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('DataChannel did not open')), 5000)
        dataChannel!.onopen = () => {
          window.clearTimeout(timeout)
          dataChannel!.send('webrtc-local-probe-ok')
          resolve()
        }
      })
      await opened
    } catch (error) {
      cleanup()
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now()
      })
      throw error
    }
  },
  reset: () => {
    cleanup()
    set({ status: 'idle', error: null, lastMessage: null, startedAt: null, completedAt: null })
  }
}))
