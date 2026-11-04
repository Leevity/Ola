import assert from 'node:assert/strict'
import fs from 'node:fs'

const contract = fs.readFileSync('src/shared/provider-contract.ts', 'utf8')
const mainStore = fs.readFileSync('src/main/providers/provider-main-store.ts', 'utf8')
const handlers = fs.readFileSync('src/main/ipc/secure-key-store.ts', 'utf8')
const secrets = fs.readFileSync('src/main/providers/provider-secret-store.ts', 'utf8')

assert.match(contract, /PROVIDER_CONTRACT_VERSION = 1/)
assert.match(mainStore, /createHash\('sha256'\)/)
assert.match(mainStore, /hasSecret:/)
assert.doesNotMatch(mainStore, /apiKey:\s*provider\.apiKey/)
assert.match(handlers, /updateProviderMainMirror\(PROVIDER_STORE_KEY, hydrated\)/)
assert.match(handlers, /provider:mirror-snapshot/)
assert.match(handlers, /getProviderSecretStore\(\)/)
assert.match(handlers, /store\.setAuthBundle\(/)
assert.match(handlers, /store\.deleteAuthBundle\(/)
assert.match(secrets, /EncryptedExtensionSecretStore/)
assert.doesNotMatch(secrets, /console\.log\([^\n]*apiKey/)

console.log('Provider Main Store verification passed')
