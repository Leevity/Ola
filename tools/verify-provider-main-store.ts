import assert from 'node:assert/strict'
import fs from 'node:fs'

const contract = fs.readFileSync('src/shared/provider-contract.ts', 'utf8')
const mainStore = fs.readFileSync('src/main/providers/provider-main-store.ts', 'utf8')
const handlers = fs.readFileSync('src/main/ipc/secure-key-store.ts', 'utf8')

assert.match(contract, /PROVIDER_CONTRACT_VERSION = 1/)
assert.match(mainStore, /createHash\('sha256'\)/)
assert.match(mainStore, /hasSecret:/)
assert.doesNotMatch(mainStore, /apiKey:\s*provider\.apiKey/)
assert.match(handlers, /updateProviderMainMirror\(key, value\)/)
assert.match(handlers, /provider:mirror-snapshot/)

console.log('Provider Main Store verification passed')
