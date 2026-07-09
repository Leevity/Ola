import { create } from 'zustand'
import { IPC } from '../lib/ipc/channels'
import { ipcClient } from '../lib/ipc/ipc-client'
import type { CredentialRef, VerificationResult } from '../../../shared/credentials'
import { credentialAgent } from '../lib/credentials/credential-agent'
import { startLoginRun } from '../lib/credentials/login-state-machine'

export interface CredentialWithVerification {
  ref: CredentialRef
  lastVerification?: VerificationResult
}

interface CredentialsStore {
  refs: CredentialRef[]
  loading: boolean
  initialized: boolean
  error: string | null
  vaultBackend: 'safe_storage' | 'in_memory_fallback' | 'unknown'
  vaultReason: string | null

  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  verifyVisually: (id: string, sessionId?: string | null) => Promise<VerificationResult | null>
  add: (input: {
    domain: string
    username: string
    password: string
    notes?: string
  }) => Promise<{ ref?: CredentialRef; verification?: VerificationResult; error?: string }>
  update: (input: {
    id: string
    username?: string
    password?: string
    notes?: string
  }) => Promise<{ ref?: CredentialRef; error?: string }>
  enableTemplate: (input: {
    templateId: string
    username: string
    password: string
  }) => Promise<{ ref?: CredentialRef; verification?: VerificationResult; error?: string }>
  reset: () => void
}

export const useCredentialsStore = create<CredentialsStore>((set, get) => ({
  refs: [],
  loading: false,
  initialized: false,
  error: null,
  vaultBackend: 'unknown',
  vaultReason: null,

  reset: () => {
    set({ refs: [], loading: false, initialized: false, error: null })
  },

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const [status, refs] = await Promise.all([
        credentialAgent.getVaultStatus(),
        credentialAgent.list()
      ])
      set({
        refs,
        vaultBackend: status.backend,
        vaultReason: status.reason ?? null,
        loading: false,
        initialized: true
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        initialized: true
      })
    }
  },

  remove: async (id: string) => {
    const before = get().refs
    // Optimistic remove
    set({ refs: before.filter((r) => r.id !== id) })
    const res = await credentialAgent.delete(id)
    if (!res.success) {
      set({ refs: before, error: res.error ?? 'delete failed' })
    }
  },

  verifyVisually: async (id: string, sessionId?: string | null) => {
    set({ error: null })
    const ref = get().refs.find((r) => r.id === id)
    if (!ref) {
      set({ error: 'credential not found' })
      return null
    }
    const startedAt = Date.now()
    const outcome = await startLoginRun({
      domain: ref.domain,
      credentialId: ref.id,
      username: ref.usernameHint ?? '',
      sessionId: sessionId ?? null,
      projectId: ref.projectId ?? null
    })
    const result: VerificationResult = {
      status:
        outcome.status === 'logged_in'
          ? 'pass'
          : outcome.status === 'paused_for_challenge'
            ? 'challenge'
            : 'fail',
      domain: ref.domain,
      durationMs: Date.now() - startedAt,
      testedAt: startedAt,
      challenge: outcome.challenge,
      failureReason:
        outcome.status === 'logged_in' || outcome.status === 'paused_for_challenge'
          ? undefined
          : outcome.reason
    }
    const recorded = await credentialAgent.recordVerification(id, result)
    if (recorded.ref) {
      set({
        refs: get().refs.map((r) => (r.id === id ? recorded.ref! : r))
      })
    } else if (recorded.error) {
      set({ error: recorded.error })
    }
    return result
  },

  update: async (input) => {
    set({ error: null })
    try {
      const res = (await ipcClient.invoke(IPC.CREDENTIALS_UPDATE, input)) as {
        ref?: CredentialRef
        error?: string
      }
      if (res.error || !res.ref) {
        return { error: res.error ?? 'update failed' }
      }
      set((state) => ({
        refs: [res.ref!, ...state.refs.filter((r) => r.id !== res.ref!.id)]
      }))
      return { ref: res.ref }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: message }
    }
  },
  add: async (input) => {
    set({ error: null })
    const res = await credentialAgent.add({ ...input, verify: false })
    if (!res.success || !res.ref) {
      const message = res.error ?? 'add failed'
      set({ error: message })
      return { error: message }
    }
    const updated: CredentialRef = {
      ...res.ref,
      lastVerifiedAt: res.verification?.testedAt,
      lastVerificationStatus: res.verification?.status
    }
    set({ refs: [updated, ...get().refs.filter((r) => r.id !== updated.id)] })
    return { ref: updated, verification: res.verification }
  },

  enableTemplate: async (input) => {
    set({ error: null })
    const res = await credentialAgent.enableBuiltinTemplate({ ...input, verify: false })
    if (!res.success || !res.ref) {
      const message = res.error ?? 'enable template failed'
      set({ error: message })
      return { error: message }
    }
    const updated: CredentialRef = {
      ...res.ref,
      lastVerifiedAt: res.verification?.testedAt,
      lastVerificationStatus: res.verification?.status
    }
    set({ refs: [updated, ...get().refs.filter((r) => r.id !== updated.id)] })
    return { ref: updated, verification: res.verification }
  }
}))
