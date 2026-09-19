// Read-only source probes. Only the path probe creates disposable temporary files.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const extension = fs.readFileSync(path.join(root, 'src/main/ipc/extension-js-runtime.ts'), 'utf8')

function extract(start, end) {
  const from = extension.indexOf(start)
  const to = extension.indexOf(end, from)
  assert(from >= 0 && to > from)
  return ts.transpile(extension.slice(from, to), { target: ts.ScriptTarget.ES2022 })
}

const sandboxFactory = new Function(
  extract('function createSandbox()', '\nexport async function executeJsExtensionToolInMain') +
    '; return createSandbox'
)()
const context = vm.createContext(sandboxFactory(), {
  codeGeneration: { strings: true, wasm: false }
})
const hostProcessType = new vm.Script(
  "console.log.constructor('return typeof process')()"
).runInContext(context, { timeout: 1000 })
assert.equal(hostProcessType, 'object')
console.log('CONFIRMED: extension context can obtain host process (type only; no secrets read)')

const networkAllowed = new Function(
  extract('function isNetworkAllowed(', '\nfunction describeExtensionFetchUrl') +
    '; return isNetworkAllowed'
)()
const instance = { manifest: { permissions: { network: ['https://api.example.com*'] } } }
assert.equal(networkAllowed(instance, 'https://api.example.com.evil.invalid/x'), true)
assert.equal(networkAllowed(instance, 'https://api.example.com@evil.invalid/x'), true)
console.log('CONFIRMED: wildcard URL prefix accepts a different origin (no network requests)')

const policySource = fs.readFileSync(path.join(root, 'src/shared/permission-policy.ts'), 'utf8')
const policyModule = { exports: {} }
new Function(
  'exports',
  ts.transpile(policySource, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS
  })
)(policyModule.exports)
const decision = policyModule.exports.evaluateToolPermission(
  'Bash',
  {
    command: 'echo audit > /tmp/ola-example-only'
  },
  {
    enabled: true,
    whitelistedTools: [],
    bashDenyRules: [],
    bashAllowRules: [{ id: 'audit', pattern: 'echo *', mode: 'wildcard', enabled: true }]
  }
)
assert.equal(decision.decision, 'allow')
console.log('CONFIRMED: echo allow rule accepts output redirection (command NOT executed)')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ola-audit-path-'))
try {
  const working = path.join(temp, 'working')
  const outside = path.join(temp, 'outside')
  fs.mkdirSync(working)
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(working, 'link'), 'dir')
  const target = path.join(working, 'link', 'probe.txt')
  // Equivalent lexical comparison to the C# guard; not a native Worker integration test.
  assert(target.toLowerCase().startsWith((working + path.sep).toLowerCase()))
  assert.notEqual(fs.realpathSync(path.dirname(target)), working)
  assert.equal(fs.realpathSync(path.dirname(target)), fs.realpathSync(outside))
  console.log('CONFIRMED: lexical workspace membership differs from resolved symlink target')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
