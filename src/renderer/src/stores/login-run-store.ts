// login-run-store: state of the active 6-step login run.
//
// The store is intentionally minimal in PR2-A: it just holds the current
// LoginRunState. PR2-B will add the state machine class that drives it,
// and PR2-C will add the handoff controls.

import { create } from 'zustand'
import type { LoginStateMachine } from '@renderer/lib/credentials/login-state-machine'
import {
  LOGIN_RUN_STEPS,
  type LoginRunState,
  type LoginStepId,
  type LoginStepState
} from '../../../shared/credentials'

interface LoginRunStore {
  run: LoginRunState | null
  machine: LoginStateMachine | null

  /** Start a new run. The state machine in PR2-B will call this. */
  setRun: (run: LoginRunState) => void
  setMachine: (machine: LoginStateMachine | null) => void

  /** Clear the run. */
  clear: () => void

  /** Helper to seed an empty pending run for all 6 steps. PR2-A only. */
  seedPending: (input: {
    id: string
    domain: string
    credentialId: string
    username: string
  }) => void
}

function buildEmptyStepStates(): Record<LoginStepId, LoginStepState> {
  const states = {} as Record<LoginStepId, LoginStepState>
  for (const id of LOGIN_RUN_STEPS) {
    states[id] = {
      id,
      status: 'pending',
      message: ''
    }
  }
  return states
}

export const useLoginRunStore = create<LoginRunStore>((set) => ({
  run: null,
  machine: null,

  setRun: (run) => set({ run }),
  setMachine: (machine) => set({ machine }),

  clear: () => {
    const machine = useLoginRunStore.getState().machine
    machine?.cancel()
    set({ run: null, machine: null })
  },

  seedPending: (input) =>
    set({
      run: {
        id: input.id,
        domain: input.domain,
        credentialId: input.credentialId,
        username: input.username,
        startedAt: Date.now(),
        currentStep: 'navigate',
        steps: [...LOGIN_RUN_STEPS],
        stepStates: buildEmptyStepStates(),
        handoff: { mode: 'agent' }
      },
      machine: null
    })
}))

/** Convenience selector for components that only need the active run. */
export function selectActiveLoginRun(state: LoginRunStore): LoginRunState | null {
  return state.run
}
