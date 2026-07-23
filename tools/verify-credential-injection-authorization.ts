import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const handlers = await readFile('src/main/ipc/credentials-handlers.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

assert.match(handlers, /function isCredentialInjectionTargetAllowed\(/)
assert.match(handlers, /target\.getType\(\) !== 'webview'/)
assert.match(handlers, /target\.hostWebContents\?\.id !== ownerWindow\.webContents\.id/)
assert.match(handlers, /url\.protocol !== 'https:'/)
assert.match(handlers, /url\.hostname\.toLowerCase\(\) !== args\.credentialDomain\.toLowerCase\(\)/)
assert.match(handlers, /getCredentialRef\(args\.credentialId\)/)
assert.match(handlers, /senderWebContentsId: event\.sender\.id/)
assert.match(handlers, /location\.href !== expectedUrl/)
assert.match(handlers, /browser navigated before credential injection/)
assert.match(handlers, /getPlaintextPassword\(args\.credentialId\)/)
assert.match(packageJson, /"verify:credential-injection-authorization"/)
assert.match(packageJson, /npm run verify:credential-injection-authorization/)

console.log('credential injection authorization verification passed')
