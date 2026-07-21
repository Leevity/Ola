import assert from 'node:assert/strict'

import {
  evaluateToolPermission,
  hasShellExpansion,
  sanitizePermissionPolicy,
  splitCommandSegments,
  type PermissionPolicy
} from '../src/shared/permission-policy.ts'

const policy: PermissionPolicy = {
  enabled: true,
  whitelistedTools: ['Write', 'mcp__github__*'],
  bashAllowRules: [
    { id: 'allow-npm', pattern: 'npm run *', mode: 'wildcard', enabled: true },
    { id: 'allow-git', pattern: 'git (status|log)', mode: 'regex', enabled: true }
  ],
  bashDenyRules: [
    { id: 'deny-rm', pattern: 'rm -rf *', mode: 'wildcard', enabled: true },
    { id: 'deny-secret', pattern: 'secret', mode: 'regex', enabled: true },
    { id: 'invalid', pattern: '[', mode: 'regex', enabled: true }
  ]
}

assert.equal(evaluateToolPermission('Write', {}, policy).decision, 'allow')
assert.equal(evaluateToolPermission('write', {}, policy).decision, 'ask')
assert.equal(evaluateToolPermission('mcp__github__search', {}, policy).decision, 'allow')
assert.equal(evaluateToolPermission('Bash', { command: 'npm run lint' }, policy).decision, 'allow')
assert.equal(evaluateToolPermission('Bash', { command: 'GIT STATUS' }, policy).decision, 'allow')
assert.equal(
  evaluateToolPermission('Bash', { command: 'npm run lint && git status' }, policy).decision,
  'allow'
)
assert.equal(
  evaluateToolPermission('Bash', { command: 'npm run lint; curl example.com' }, policy).decision,
  'ask'
)
assert.equal(evaluateToolPermission('Bash', { command: 'rm -rf build' }, policy).decision, 'deny')
assert.equal(evaluateToolPermission('Bash', { command: 'npm run secret' }, policy).decision, 'deny')
assert.equal(
  evaluateToolPermission('Bash', { command: 'npm run $(danger)' }, policy).decision,
  'ask'
)
assert.equal(hasShellExpansion('echo `whoami`'), true)
assert.deepEqual(splitCommandSegments('one | two && three; four\nfive'), [
  'one',
  'two',
  'three',
  'four',
  'five'
])
assert.equal(
  evaluateToolPermission('Bash', { command: 'rm -rf build' }, { ...policy, enabled: false })
    .decision,
  'ask'
)

const sanitized = sanitizePermissionPolicy({
  enabled: true,
  whitelistedTools: [' Write ', 'Write', 42],
  bashAllowRules: [{ pattern: 'git *', mode: 'unexpected' }]
})
assert.deepEqual(sanitized.whitelistedTools, ['Write'])
assert.equal(sanitized.bashAllowRules[0].mode, 'wildcard')

console.log('permission policy verification passed')
