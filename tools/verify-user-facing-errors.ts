import assert from 'node:assert/strict'
import { explainUserFacingError } from '../src/renderer/src/lib/user-facing-error.ts'

const cases: Array<[string | undefined, string, string, string | null]> = [
  [
    'stream_recovery_unavailable',
    'Agent stream was interrupted',
    'refreshStatus',
    'assistantMessage.agentError.messageStreamRecovery'
  ],
  [
    'sidecar_unavailable',
    'Sidecar unavailable.',
    'openSystem',
    'assistantMessage.agentError.messageRuntimeUnavailable'
  ],
  [
    undefined,
    '401 invalid api key',
    'openProvider',
    'assistantMessage.agentError.messageAuthentication'
  ],
  [
    undefined,
    'No AI provider available',
    'openProvider',
    'assistantMessage.agentError.messageProviderMissing'
  ],
  [
    undefined,
    'No AI model available',
    'openModel',
    'assistantMessage.agentError.messageModelMissing'
  ],
  [
    undefined,
    'getaddrinfo ENOTFOUND provider.example',
    'openSystem',
    'assistantMessage.agentError.messageNetwork'
  ],
  [undefined, '429 too many requests', 'null', 'assistantMessage.agentError.messageRateLimit'],
  [undefined, 'insufficient balance', 'openProvider', 'assistantMessage.agentError.messageBalance'],
  [undefined, 'request timed out', 'refreshStatus', 'assistantMessage.agentError.messageTimeout'],
  [undefined, '502 upstream unavailable', 'null', 'assistantMessage.agentError.messageUpstream'],
  [
    undefined,
    '422 validation error',
    'openModel',
    'assistantMessage.agentError.messageRequestInvalid'
  ],
  ['tool_error', 'file tool failed', 'null', 'assistantMessage.agentError.messageToolFailed'],
  [undefined, 'unclassified message', 'null', null]
]
for (const [errorType, message, action, messageKey] of cases) {
  const result = explainUserFacingError(errorType, message)
  assert.equal(result.action, action === 'null' ? null : action)
  assert.equal(result.messageKey, messageKey)
}
console.log('user-facing error verification passed')
