/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const readJson = (filename) => JSON.parse(readFileSync(path.join(root, filename), 'utf8'))
const ledger = readJson('docs/migrations/ts-runtime/acceptance-ledger.json')
const inventory = readJson('docs/migrations/ts-runtime/capability-inventory.json')
const baseline = readJson('docs/migrations/ts-runtime/worktree-baseline.json')
const exitMode = process.argv.includes('--exit')
const errors = []
const unaccepted = []
const validStatuses = new Set(['未开始', '实现中', '待验收', '通过', '受外部条件阻塞'])

function check(condition, message) {
  if (!condition) errors.push(message)
}

function evidence(value, label, required) {
  check(Array.isArray(value), `${label}: evidence must be an array`)
  if (!Array.isArray(value)) return
  if (required) check(value.length > 0, `${label}: missing evidence`)
  for (const item of value) {
    const reference = typeof item === 'string' ? item.trim() : ''
    check(
      Boolean(reference) && !/TODO|TBD/i.test(reference),
      `${label}: invalid evidence reference`
    )
    if (reference && !/^https:\/\//.test(reference)) {
      const target = path.resolve(root, reference.split('#')[0])
      check(
        target.startsWith(`${root}${path.sep}`) && existsSync(target),
        `${label}: evidence file missing: ${reference}`
      )
    }
  }
}

function sourceFile(value, label) {
  check(typeof value === 'string' && value.length > 0, `${label}: source path missing`)
  if (typeof value !== 'string' || !value) return
  const target = path.resolve(root, value)
  check(
    target.startsWith(`${root}${path.sep}`) && existsSync(target),
    `${label}: source file missing: ${value}`
  )
}

function status(entry, label) {
  check(validStatuses.has(entry?.status), `${label}: invalid status`)
  if (exitMode && entry?.status !== '通过') unaccepted.push(label)
  return entry?.status === '通过'
}

function exactIds(actual, expected, label) {
  check(Array.isArray(actual), `${label}: missing entries`)
  if (!Array.isArray(actual)) return
  const actualIds = actual.map((item) => item.id)
  check(new Set(actualIds).size === actualIds.length, `${label}: duplicate id`)
  check(
    actualIds.length === expected.length && expected.every((id) => actualIds.includes(id)),
    `${label}: inventory mismatch`
  )
}

check(ledger.schemaVersion === 1, 'ledger schema version mismatch')
check(baseline.schemaVersion === 1 && baseline.files.length > 0, 'worktree baseline missing')
check(
  JSON.stringify(ledger.statusValues) === JSON.stringify([...validStatuses]),
  'ledger status vocabulary mismatch'
)
exactIds(
  ledger.phases,
  Array.from({ length: 13 }, (_, index) => `P${index}`),
  'phases'
)
exactIds(
  ledger.routes,
  inventory.routes.map((route) => route.method),
  'routes'
)
exactIds(
  ledger.codegraphLanguages,
  inventory.codegraphLanguages.map((language) => language.id),
  'CodeGraph languages'
)
exactIds(
  ledger.releaseTargets,
  ['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'],
  'release targets'
)

for (const phase of ledger.phases ?? []) {
  const accepted = status(phase, phase.id)
  evidence(phase.evidence, phase.id, accepted)
}
const inventoryRoutes = new Map(inventory.routes.map((route) => [route.method, route]))
for (const route of ledger.routes ?? []) {
  const label = `route ${route.id}`
  const accepted = status(route, label)
  check(route.legacyEntrypoint === route.id, `${label}: legacy entrypoint mismatch`)
  check(
    route.legacySource === inventoryRoutes.get(route.id)?.source,
    `${label}: legacy source mismatch`
  )
  if (accepted) {
    sourceFile(route.tsImplementation, `${label}: TS implementation`)
    sourceFile(route.productionCallPath, `${label}: production path`)
    check(route.legacyPathRemoved === true, `${label}: legacy path remains`)
  }
  evidence(route.contractEvidence, label, accepted)
  evidence(route.e2eEvidence, label, accepted)
}
for (const language of ledger.codegraphLanguages ?? []) {
  const label = `CodeGraph ${language.id}`
  const accepted = status(language, label)
  if (accepted) sourceFile(language.tsImplementation, `${label}: TS implementation`)
  evidence(language.semanticEvidence, label, accepted)
  evidence(language.incrementalEvidence, label, accepted)
  evidence(language.performanceEvidence, label, accepted)
}
for (const target of ledger.releaseTargets ?? []) {
  const accepted = status(target, target.id)
  for (const key of [
    'buildEvidence',
    'installEvidence',
    'upgradeEvidence',
    'launchEvidence',
    'signingEvidence',
    'noDotnetEvidence'
  ]) {
    evidence(target[key], `${target.id}.${key}`, accepted)
  }
}
const siteAccepted = status(ledger.realSite, 'real main site')
for (const key of [
  'personalAndTeamDirectoryEvidence',
  'ticketAndStreamingEvidence',
  'revokeAndFailureEvidence'
]) {
  evidence(ledger.realSite?.[key], `realSite.${key}`, siteAccepted)
}

if (exitMode) {
  const forbiddenSources = [
    'src/main/lib/native-worker.ts',
    'src/main/ipc/native-agent-runtime.ts',
    'src/main/ipc/sidecar-manager.ts',
    'src/main/lib/codegraph-worker.ts'
  ]
  for (const filename of forbiddenSources) {
    check(!existsSync(path.join(root, filename)), `legacy production source remains: ${filename}`)
  }
  const sourcePatterns = [
    /getNativeWorker\s*\(/,
    /runAgentViaSidecar\s*\(/,
    /from\s+['"][^'"]*(?:native-worker|native-agent-runtime|sidecar-manager|run-agent-via-sidecar|codegraph-worker)['"]/
  ]
  for (const sourceRoot of [
    'src/main',
    'src/preload',
    'src/renderer/src',
    'src/runtime',
    'cli/src'
  ]) {
    const directory = path.join(root, sourceRoot)
    if (!existsSync(directory)) continue
    const queue = [directory]
    while (queue.length) {
      const current = queue.pop()
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name)
        if (entry.isDirectory()) queue.push(filename)
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
          const source = readFileSync(filename, 'utf8')
          if (sourcePatterns.some((pattern) => pattern.test(source))) {
            errors.push(`legacy production dependency remains: ${path.relative(root, filename)}`)
          }
        }
      }
    }
  }
  const sidecars = path.join(root, 'sidecars')
  if (existsSync(sidecars)) {
    const queue = [sidecars]
    while (queue.length) {
      const directory = queue.pop()
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['bin', 'obj'].includes(entry.name)) continue
        const filename = path.join(directory, entry.name)
        if (entry.isDirectory()) queue.push(filename)
        else if (/\.(?:cs|csproj|sln|fs|fsproj)$/.test(entry.name)) {
          errors.push(`.NET source remains: ${path.relative(root, filename)}`)
        }
      }
    }
  }
  const packageJson = readJson('package.json')
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    check(
      !/(?:dotnet|codegraph:publish|native:publish|package:prepare:legacy)/i.test(
        `${name} ${command}`
      ),
      `legacy package script remains: ${name}`
    )
  }
  for (const filename of ['.github/workflows/build.yml', 'scripts/predev.mjs']) {
    const source = readFileSync(path.join(root, filename), 'utf8')
    check(
      !/(?:dotnet|codegraph:publish)/i.test(source),
      `legacy build dependency remains: ${filename}`
    )
  }
  const assets = readJson('src/shared/worker-assets.json')
  check(
    !assets.assets.some((asset) => ['native-worker', 'codegraph-worker'].includes(asset.id)),
    'legacy worker asset remains'
  )
  const mainBundle = path.join(root, 'out/main/index.js')
  check(existsSync(mainBundle), 'production Main bundle missing')
  if (existsSync(mainBundle)) {
    const source = readFileSync(mainBundle, 'utf8')
    check(
      !/(?:Ola\.Native\.Worker|Ola\.CodeGraph\.Worker|LEGACY_NATIVE_WORKERS_DISABLED|sidecar:start)/.test(
        source
      ),
      'production Main bundle still contains .NET worker path'
    )
  }
  const rendererAssets = path.join(root, 'out/renderer/assets')
  check(existsSync(rendererAssets), 'production Renderer assets missing')
  if (existsSync(rendererAssets)) {
    for (const entry of readdirSync(rendererAssets, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const source = readFileSync(path.join(rendererAssets, entry.name), 'utf8')
      if (
        /(?:Ola\.Native\.Worker|Ola\.CodeGraph\.Worker|sidecar:start|sidecar:can-handle)/.test(
          source
        )
      ) {
        errors.push(`production Renderer bundle still contains Sidecar path: ${entry.name}`)
      }
    }
  }
}

const total = (ledger.routes?.length ?? 0) + (ledger.codegraphLanguages?.length ?? 0)
const accepted = [...(ledger.routes ?? []), ...(ledger.codegraphLanguages ?? [])].filter(
  (entry) => entry.status === '通过'
).length
console.log(
  `TS migration ledger: ${accepted}/${total} route/language entries accepted; exit mode=${exitMode}`
)
if (unaccepted.length) {
  errors.push(
    `${unaccepted.length} acceptance entries remain open (first: ${unaccepted.slice(0, 8).join(', ')})`
  )
}
if (errors.length) {
  for (const error of errors.slice(0, 25)) console.error(`- ${error}`)
  if (errors.length > 25) console.error(`... ${errors.length - 25} more failures`)
  process.exitCode = 1
} else {
  console.log('TS migration ledger verification passed')
}
