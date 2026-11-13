import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Credential-injection authorization is a security invariant about tokens, not layout.
// The sources are read with whitespace collapsed so a re-wrap cannot turn the gate red;
// patterns tolerate a space wherever the formatter may break a line. The webview-type
// and hostWebContents ownership comparisons keep their exact operands and operators.
// Nothing here is line-anchored.
const handlers = await readCollapsedSource('src/main/ipc/credentials-handlers.ts')
const packageJson = await readCollapsedSource('package.json')

assert.match(handlers, /function isCredentialInjectionTargetAllowed\(/)
// The allow-decision must be enforced where the plaintext is injected. Bind the guard
// to the isCredentialInjectionTargetAllowed call so an unrelated `if` cannot satisfy it
// and replacing the enforcement with `if (false)` turns the gate red.
assert.match(
  handlers,
  /const\s+target\s*=\s*isCredentialInjectionTargetAllowed\(\s*\{[^}]*\}\s*\)\s*if\s*\(\s*!target\s*\.\s*allowed\s*\)\s*return\s*\{\s*status:\s*'error',\s*error:\s*target\s*\.\s*error\s*\}/,
  'credential injection must enforce the target allow-decision before injecting'
)
assert.match(handlers, /target\.getType\(\)\s*!==\s*'webview'/)
assert.match(handlers, /target\.hostWebContents\?\.id\s*!==\s*ownerWindow\.webContents\.id/)
assert.match(handlers, /getRegisteredBrowserGuest\(/)
assert.match(handlers, /browser tab is not registered with the Main browser service/)
assert.match(handlers, /url\.protocol\s*!==\s*'https:'/)
assert.match(
  handlers,
  /url\.hostname\.toLowerCase\(\)\s*!==\s*args\.credentialDomain\.toLowerCase\(\)/
)
assert.match(handlers, /getCredentialRef\(\s*args\.credentialId\s*\)/)
assert.match(handlers, /senderWebContentsId:\s*event\.sender\.id/)
assert.match(handlers, /location\.href\s*!==\s*expectedUrl/)
assert.match(handlers, /browser navigated before credential injection/)
assert.match(handlers, /getPlaintextPassword\(\s*args\.credentialId\s*\)/)
assert.match(packageJson, /"verify:credential-injection-authorization"/)
assert.match(packageJson, /npm run verify:credential-injection-authorization/)

console.log('credential injection authorization verification passed')
