import { expect, it } from 'vitest'
import {
  getScenarioProviderObservation,
  isCurrentProjectPreflight,
  isCurrentSshPreflight
} from '../../src/renderer/src/lib/scenario-preflight'

const current = {
  requestId: 4,
  currentRequestId: 4,
  checkedWorkspaceId: 'workspace-a',
  currentWorkspaceId: 'workspace-a',
  checkedFolder: 'C:/projects/app',
  currentFolder: 'C:/projects/app'
}

it('accepts a project directory result only for the current request and context', () => {
  expect(isCurrentProjectPreflight(current)).toBe(true)
})

it.each([
  ['superseded request', { currentRequestId: 5 }],
  ['changed workspace', { currentWorkspaceId: 'workspace-b' }],
  ['changed folder', { currentFolder: 'C:/projects/other' }],
  ['missing folder', { currentFolder: undefined }]
])('rejects a stale project directory result after %s', (_reason, patch) => {
  expect(isCurrentProjectPreflight({ ...current, ...patch })).toBe(false)
})

const currentSsh = {
  requestId: 8,
  currentRequestId: 8,
  checkedWorkspaceId: 'workspace-a',
  currentWorkspaceId: 'workspace-a',
  checkedConnectionId: 'server-a',
  currentConnectionId: 'server-a',
  scenarioOpen: true
}

it('accepts an SSH check only for the open scenario and current connection', () => {
  expect(isCurrentSshPreflight(currentSsh)).toBe(true)
})

it.each([
  ['superseded request', { currentRequestId: 9 }],
  ['changed workspace', { currentWorkspaceId: 'workspace-b' }],
  ['changed connection', { currentConnectionId: 'server-b' }],
  ['closed scenario', { scenarioOpen: false }]
])('rejects a stale SSH result after %s', (_reason, patch) => {
  expect(isCurrentSshPreflight({ ...currentSsh, ...patch })).toBe(false)
})

it('uses only the selected provider health record for scenario preflight', () => {
  const selected = {
    providerKey: 'provider-current',
    status: 'degraded',
    consecutiveFailures: 1,
    totalRequests: 3,
    successfulRequests: 2,
    failedRequests: 1,
    averageLatencyMs: 120,
    lastFailedAt: 9,
    updatedAt: 10
  } as const
  const unrelated = { ...selected, providerKey: 'provider-other', status: 'healthy' } as const
  expect(getScenarioProviderObservation(' provider-current ', [unrelated, selected])).toBe(selected)
  expect(getScenarioProviderObservation('missing-provider', [unrelated, selected])).toBeNull()
  expect(getScenarioProviderObservation(null, [selected])).toBeNull()
})

it('does not treat a provider entry created for an in-flight request as a response', () => {
  const inFlight = {
    providerKey: 'provider-current',
    status: 'healthy',
    consecutiveFailures: 0,
    totalRequests: 1,
    successfulRequests: 0,
    failedRequests: 0,
    averageLatencyMs: null,
    updatedAt: 10
  } as const

  expect(getScenarioProviderObservation('provider-current', [inFlight])).toBeNull()
})
