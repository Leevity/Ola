import { create } from 'zustand'
import {
  subscribeRemoteSignalMessages,
  useRemoteSignalingStore,
  type RemoteSignalMessage
} from '@renderer/stores/remote-signaling-store'
import {
  getRemoteCaptureDisplayId,
  getRemoteCaptureStream
} from '@renderer/stores/remote-capture-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { RemoteInputEnvelope, RemoteInputEvent } from '@renderer/lib/remote/remote-types'

export type RemotePeerStatus =
  | 'idle'
  | 'listening'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'closed'
export type RemotePeerRole = 'controller' | 'controlled' | null

type IceServer = { urls: string; username?: string; credential?: string }

type SignalPayload = {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  iceServers?: IceServer[]
  label?: string
}

type ControllerSessionAuthorization = { sessionId: string; ticket: string }
type RemotePeerQuality = {
  transport: 'p2p' | 'turn' | 'unknown'
  roundTripTimeMs: number | null
  bytesReceived: number
  framesPerSecond: number | null
}

type RemotePeerStore = {
  status: RemotePeerStatus
  role: RemotePeerRole
  sessionId: string | null
  peerDeviceId: string | null
  peerDeviceName: string | null
  error: string | null
  lastMessage: string | null
  startedAt: number | null
  connectedAt: number | null
  remoteStream: MediaStream | null
  quality: RemotePeerQuality | null
  listenForIncoming: (localDeviceId: string | null, allowIncoming: boolean) => () => void
  startControllerSession: (
    targetDeviceId: string,
    authorization: ControllerSessionAuthorization,
    iceServers?: IceServer[]
  ) => Promise<void>
  sendInput: (event: RemoteInputEvent) => void
  closeSession: () => void
}

let peer: RTCPeerConnection | null = null
let dataChannel: RTCDataChannel | null = null
let signalUnsubscribe: (() => void) | null = null
let localDeviceId: string | null = null
let allowIncomingControl = false
let queuedCandidates: RTCIceCandidateInit[] = []
let offerSent = false
let pendingRemoteCandidates: RTCIceCandidateInit[] = []
let qualityTimer: number | null = null
let lastStatsReportAt = 0

function createSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `remote-${Date.now()}-${Math.random()}`
}

function normalizePayload(payload: unknown): SignalPayload {
  return payload && typeof payload === 'object' ? (payload as SignalPayload) : {}
}

function sendSignal(message: Omit<RemoteSignalMessage, 'from' | 'sentAt'>): void {
  useRemoteSignalingStore.getState().send(message)
}

function cleanupPeer(): void {
  void ipcClient.invoke(IPC.REMOTE_INPUT_SET_SESSION, { sessionId: null })
  const channelToClose = dataChannel
  const peerToClose = peer
  dataChannel = null
  peer = null
  channelToClose?.close()
  peerToClose?.close()
  queuedCandidates = []
  offerSent = false
  pendingRemoteCandidates = []
  if (qualityTimer !== null) window.clearInterval(qualityTimer)
  qualityTimer = null
  lastStatsReportAt = 0
}

function terminateTransportSession(
  expectedPeer: RTCPeerConnection,
  status: 'closed' | 'error',
  error: string | null,
  set: (patch: Partial<RemotePeerStore>) => void
): void {
  if (peer !== expectedPeer) return
  const state = useRemotePeerStore.getState()
  if (state.sessionId && state.peerDeviceId) {
    try {
      sendSignal({
        type: 'close',
        to: state.peerDeviceId,
        sessionId: state.sessionId,
        payload: { label: status === 'error' ? 'transport_failed' : 'transport_closed' }
      })
    } catch {
      // Transport cleanup is authoritative even when signaling is unavailable.
    }
  }
  cleanupPeer()
  set({
    status,
    role: null,
    sessionId: null,
    peerDeviceId: null,
    peerDeviceName: null,
    error,
    lastMessage: null,
    startedAt: null,
    remoteStream: null,
    quality: null,
    connectedAt: null
  })
}

function reportSessionStats(quality: RemotePeerQuality, force = false): void {
  const state = useRemotePeerStore.getState()
  const now = Date.now()
  if (
    state.role !== 'controller' ||
    !state.sessionId ||
    !state.peerDeviceId ||
    quality.transport === 'unknown' ||
    (!force && now - lastStatsReportAt < 10_000)
  ) {
    return
  }
  try {
    sendSignal({
      type: 'stats',
      to: state.peerDeviceId,
      sessionId: state.sessionId,
      payload: {
        transport: quality.transport,
        bytesTransferred: Math.max(0, Math.floor(quality.bytesReceived))
      }
    })
    lastStatsReportAt = now
  } catch {
    // Quality reporting is best-effort and must never interrupt the media session.
  }
}

async function updatePeerQuality(
  pc: RTCPeerConnection,
  set: (patch: Partial<RemotePeerStore>) => void
): Promise<void> {
  const reports = await pc.getStats()
  let transport: RemotePeerQuality['transport'] = 'unknown'
  let roundTripTimeMs: number | null = null
  let bytesReceived = 0
  let framesPerSecond: number | null = null
  let selectedRemoteCandidateID: string | null = null
  reports.forEach((raw) => {
    const report = raw as RTCStats & Record<string, unknown>
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
      selectedRemoteCandidateID = String(report.remoteCandidateId ?? '')
      const seconds = Number(report.currentRoundTripTime)
      if (Number.isFinite(seconds)) roundTripTimeMs = Math.round(seconds * 1000)
    }
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      bytesReceived = Number(report.bytesReceived ?? 0)
      const fps = Number(report.framesPerSecond)
      if (Number.isFinite(fps)) framesPerSecond = fps
    }
  })
  if (selectedRemoteCandidateID) {
    const candidate = reports.get(selectedRemoteCandidateID) as
      | (RTCStats & Record<string, unknown>)
      | undefined
    transport = candidate?.candidateType === 'relay' ? 'turn' : 'p2p'
  }
  const quality = { transport, roundTripTimeMs, bytesReceived, framesPerSecond }
  set({ quality })
  reportSessionStats(quality)
}

function startQualityMonitor(
  pc: RTCPeerConnection,
  set: (patch: Partial<RemotePeerStore>) => void
): void {
  if (qualityTimer !== null) window.clearInterval(qualityTimer)
  void updatePeerQuality(pc, set)
  qualityTimer = window.setInterval(() => void updatePeerQuality(pc, set), 2000)
}

async function flushRemoteCandidates(pc: RTCPeerConnection): Promise<void> {
  for (const candidate of pendingRemoteCandidates.splice(0)) {
    await pc.addIceCandidate(candidate)
  }
}

function attachDataChannel(
  channel: RTCDataChannel,
  owningPeer: RTCPeerConnection,
  set: (patch: Partial<RemotePeerStore>) => void
): void {
  dataChannel = channel
  channel.onopen = () => {
    set({ status: 'connected', connectedAt: Date.now(), error: null })
    const state = useRemotePeerStore.getState()
    if (state.role === 'controlled' && state.sessionId) {
      void ipcClient.invoke(IPC.REMOTE_INPUT_SET_SESSION, {
        sessionId: state.sessionId,
        displayId: getRemoteCaptureDisplayId()
      })
    }
    channel.send('ola-remote-datachannel-ok')
  }
  channel.onmessage = (event) => {
    const text = String(event.data)
    try {
      const message = JSON.parse(text) as { kind?: string; envelope?: RemoteInputEnvelope }
      const state = useRemotePeerStore.getState()
      if (message.kind === 'input' && message.envelope && state.role === 'controlled') {
        void ipcClient.invoke(IPC.REMOTE_INPUT_DISPATCH, message.envelope)
        return
      }
    } catch {
      // Probe and compatibility messages are intentionally plain text.
    }
    set({ lastMessage: text })
  }
  channel.onerror = () => {
    terminateTransportSession(owningPeer, 'error', 'Remote DataChannel failed', set)
  }
  channel.onclose = () => {
    if (dataChannel === channel) terminateTransportSession(owningPeer, 'closed', null, set)
  }
}

function createPeer(
  targetDeviceId: string,
  sessionId: string,
  iceServers: IceServer[] | undefined,
  set: (patch: Partial<RemotePeerStore>) => void
): RTCPeerConnection {
  cleanupPeer()
  const pc = new RTCPeerConnection({ iceServers: iceServers ?? [] })
  peer = pc
  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    const candidate = event.candidate.toJSON()
    if (!offerSent) {
      queuedCandidates.push(candidate)
      return
    }
    sendSignal({ type: 'candidate', to: targetDeviceId, sessionId, payload: { candidate } })
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      startQualityMonitor(pc, set)
    } else if (pc.connectionState === 'failed') {
      terminateTransportSession(pc, 'error', 'Remote peer connection failed', set)
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      terminateTransportSession(pc, 'closed', null, set)
    }
  }
  pc.ondatachannel = (event) => attachDataChannel(event.channel, pc, set)
  pc.ontrack = (event) => {
    const [stream] = event.streams
    if (stream) set({ remoteStream: stream })
  }
  return pc
}

async function handleIncomingSignal(
  message: RemoteSignalMessage,
  set: (patch: Partial<RemotePeerStore>) => void,
  get: () => RemotePeerStore
): Promise<void> {
  if (!localDeviceId || message.to !== localDeviceId || !message.from || !message.sessionId) return

  const payload = normalizePayload(message.payload)

  if (message.type === 'offer') {
    if (!allowIncomingControl || !payload.description) return
    const pc = createPeer(message.from, message.sessionId, payload.iceServers, set)
    const captureStream = getRemoteCaptureStream()
    if (!captureStream) throw new Error('Screen capture must be active before accepting control')
    for (const track of captureStream.getTracks()) pc.addTrack(track, captureStream)
    set({
      status: 'connecting',
      role: 'controlled',
      sessionId: message.sessionId,
      peerDeviceId: message.from,
      peerDeviceName: message.peerName?.trim() || null,
      error: null,
      startedAt: Date.now(),
      connectedAt: null,
      lastMessage: null,
      remoteStream: null,
      quality: null
    })
    await pc.setRemoteDescription(payload.description)
    await flushRemoteCandidates(pc)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    sendSignal({
      type: 'answer',
      to: message.from,
      sessionId: message.sessionId,
      payload: { description: answer }
    })
    offerSent = true
    for (const candidate of queuedCandidates.splice(0)) {
      sendSignal({
        type: 'candidate',
        to: message.from,
        sessionId: message.sessionId,
        payload: { candidate }
      })
    }
    return
  }

  if (message.type === 'answer') {
    if (get().sessionId !== message.sessionId || !peer || !payload.description) return
    await peer.setRemoteDescription(payload.description)
    await flushRemoteCandidates(peer)
    return
  }

  if (message.type === 'candidate') {
    if (get().sessionId !== message.sessionId || !peer || !payload.candidate) return
    if (!peer.remoteDescription) {
      pendingRemoteCandidates.push(payload.candidate)
      return
    }
    await peer.addIceCandidate(payload.candidate)
    return
  }

  if (message.type === 'close' && get().sessionId === message.sessionId) {
    cleanupPeer()
    set({
      status: 'closed',
      role: null,
      sessionId: null,
      peerDeviceId: null,
      peerDeviceName: null,
      error: null,
      lastMessage: null,
      startedAt: null,
      remoteStream: null,
      quality: null,
      connectedAt: null
    })
  }
}

export const useRemotePeerStore = create<RemotePeerStore>((set, get) => ({
  status: 'idle',
  role: null,
  sessionId: null,
  peerDeviceId: null,
  peerDeviceName: null,
  error: null,
  lastMessage: null,
  startedAt: null,
  connectedAt: null,
  remoteStream: null,
  quality: null,
  listenForIncoming: (nextLocalDeviceId, nextAllowIncoming) => {
    localDeviceId = nextLocalDeviceId
    allowIncomingControl = nextAllowIncoming
    if (!signalUnsubscribe) {
      signalUnsubscribe = subscribeRemoteSignalMessages((message) => {
        void handleIncomingSignal(message, set, get).catch((error) => {
          set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        })
      })
    }
    set({ status: get().status === 'idle' ? 'listening' : get().status })
    return () => {
      localDeviceId = null
      allowIncomingControl = false
    }
  },
  startControllerSession: async (targetDeviceId, authorization, iceServers) => {
    if (!targetDeviceId) throw new Error('Target device id is required')
    const sessionId = authorization.sessionId || createSessionId()
    const pc = createPeer(targetDeviceId, sessionId, iceServers, set)
    set({
      status: 'connecting',
      role: 'controller',
      sessionId,
      peerDeviceId: targetDeviceId,
      peerDeviceName: null,
      error: null,
      lastMessage: null,
      startedAt: Date.now(),
      connectedAt: null,
      remoteStream: null,
      quality: null
    })
    const channel = pc.createDataChannel('control', { ordered: true })
    attachDataChannel(channel, pc, set)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      sendSignal({
        type: 'offer',
        to: targetDeviceId,
        sessionId,
        authorization: authorization.ticket,
        payload: { description: offer, iceServers }
      })
      offerSent = true
      for (const candidate of queuedCandidates.splice(0)) {
        sendSignal({ type: 'candidate', to: targetDeviceId, sessionId, payload: { candidate } })
      }
    } catch (error) {
      cleanupPeer()
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
  sendInput: (event) => {
    const state = get()
    if (state.role !== 'controller' || !state.sessionId) {
      throw new Error('Remote input requires an active controller session')
    }
    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error('Remote control DataChannel is not open')
    }
    const envelope: RemoteInputEnvelope = { sessionId: state.sessionId, event }
    dataChannel.send(JSON.stringify({ kind: 'input', envelope }))
  },
  closeSession: () => {
    const state = get()
    if (state.sessionId && state.peerDeviceId) {
      try {
        if (state.quality) reportSessionStats(state.quality, true)
        sendSignal({
          type: 'close',
          to: state.peerDeviceId,
          sessionId: state.sessionId,
          payload: { label: 'peer_closed' }
        })
      } catch {
        // Local cleanup remains authoritative when signaling is already unavailable.
      }
    }
    cleanupPeer()
    set({
      status: 'closed',
      role: null,
      sessionId: null,
      peerDeviceId: null,
      peerDeviceName: null,
      error: null,
      lastMessage: null,
      startedAt: null,
      connectedAt: null,
      remoteStream: null,
      quality: null
    })
  }
}))
