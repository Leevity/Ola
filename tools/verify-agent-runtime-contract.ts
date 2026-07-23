import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const contract = JSON.parse(
  (await readFile('contracts/agent-runtime-contract.json', 'utf8')).replace(/^\uFEFF/, '')
) as {
  version: number
  routes: Record<string, string>
  capabilities: string[]
}
const generator = await readFile('scripts/generate-agent-runtime-contract.mjs', 'utf8')
const workerModule = await readFile(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeModule.cs',
  'utf8'
)
const workerTools = await readFile(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeTools.cs',
  'utf8'
)
const packageJson = await readFile('package.json', 'utf8')

assert.ok(Number.isSafeInteger(contract.version) && contract.version > 0)
assert.ok(Object.keys(contract.routes).length > 0)
assert.ok(contract.capabilities.length > 0)
assert.equal(new Set(Object.values(contract.routes)).size, Object.keys(contract.routes).length)
assert.equal(new Set(contract.capabilities).size, contract.capabilities.length)

assert.match(generator, /process\.argv\.includes\('--check'\)/)
assert.match(generator, /Generated Agent Runtime contract is out of date/)
assert.match(packageJson, /"generate:agent-runtime-contract"/)
assert.match(packageJson, /"verify:agent-runtime-contract"/)
assert.match(packageJson, /npm run verify:agent-runtime-contract/)

for (const key of Object.keys(contract.routes)) {
  const constant = `${key.replace(/(^|[_-])([a-z])/g, (_, __, char) => char.toUpperCase())}Route`
  assert.match(workerModule, new RegExp(`AgentRuntimeContract\\.${constant}`))
}

for (const route of Object.values(contract.routes)) {
  assert.doesNotMatch(workerModule, new RegExp(`context\\.Register\\("${route}"`))
}

assert.match(workerTools, /AgentRuntimeContract\.Capabilities\.Contains\(capability\)/)
assert.doesNotMatch(workerTools, /capability is "agent\.run"/)

console.log('agent runtime contract verification passed')
