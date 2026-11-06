import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The gate for the accessibility desktop tools. `docs/agent-desktop-acceptance.md` is the switch and
 * this script is what keeps the switch honest: it refuses a table that claims something the source no
 * longer proves, refuses a red table whose lockdown has already been removed, and with `--strict`
 * refuses any row that has not been accepted. ci-core runs the default form; the unhide runs
 * `npm run verify:desktop-ax-gate:strict`.
 */

const DOC_PATH = 'docs/agent-desktop-acceptance.md'
const AX_TOOL_NAMES = [
  'desktop_ax_launch',
  'desktop_ax_list',
  'desktop_ax_snapshot',
  'desktop_ax_inspect',
  'desktop_ax_click',
  'desktop_ax_input_text',
  'desktop_ax_adjust'
]
const FORBIDDEN_FLAGS = [
  '--headed',
  '--cdp',
  '--include-bounds',
  '--arg',
  '--env',
  '--force',
  '--activate',
  '--screenshot',
  '--debug',
  '--trace',
  '--trace-strict',
  '--no-attach'
]
const FORBIDDEN_VERBS = [
  'close-app',
  'quit',
  'kill',
  'permissions',
  'mcp',
  'batch',
  'session',
  'hover',
  'press',
  'drag',
  'key-down',
  'key-up',
  'clipboard-get',
  'clipboard-set',
  'notification-action'
]

/** Every row the table must carry. A silently deleted row is the gate deleting itself. */
const REQUIRED_ROWS: Record<string, 'static' | 'platform' | 'release'> = {
  'argv-red-lines': 'static',
  'headless-only': 'static',
  'approval-before-mutation': 'static',
  'unattended-refusal': 'static',
  'backend-fail-closed': 'static',
  'allowlist-before-approval': 'static',
  'binary-integrity-pin': 'static',
  'result-budget-bound': 'static',
  'guidance-when-unavailable': 'static',
  'lockdown-coupling': 'static',
  'ci-platform-coverage': 'static',
  'bundled-binary-signing': 'static',
  'sbom-registration': 'static',
  'macos-accessibility-suite': 'platform',
  'macos-snapshot-budget': 'platform',
  'windows-uia-suite': 'platform',
  'windows-text-input': 'platform',
  'windows-twin-ref': 'platform',
  'linux-x11-suite': 'platform',
  'linux-wayland-refusal': 'platform',
  'mac-signing': 'release',
  'windows-artifact-containment': 'release'
}

const strict = process.argv.includes('--strict')
const read = (path: string): string => readFileSync(path, 'utf8')

const argvBuilder = read('src/main/agent-desktop/args.ts')
const client = read('src/main/agent-desktop/cli-client.ts')
const detector = read('src/main/agent-desktop/detector.ts')
const shrink = read('src/main/agent-desktop/snapshot-shrink.ts')
const tools = read('src/main/runtime/desktop-ax-runtime-tools.ts')
const authorization = read('src/main/runtime/runtime-tool-authorization.ts')
const registration = read('src/main/runtime/desktop-runtime.ts')
const descriptors = read('src/renderer/src/lib/app-plugin/types.ts')
const pluginStore = read('src/renderer/src/stores/app-plugin-store.ts')
const eligibility = read('src/renderer/src/lib/ipc/ts-runtime-text-eligibility.ts')
const rendererClip = read('src/renderer/src/stores/agent-store.ts')
const workflow = read('.github/workflows/build.yml')
const afterPack = read('build/after-sign-mac.cjs')
const macSign = read('scripts/agent-desktop-mac-sign.mjs')
const releaseVerify = read('scripts/verify-release-artifacts.mjs')
const sbomPins = read('scripts/agent-desktop-sbom.mjs')
const sbomWriter = read('scripts/release-sbom.mjs')
const lock = JSON.parse(read('resources/agent-desktop.lock.json')) as {
  platforms: Record<string, { cli: string; binaries: Record<string, { sha256: string }> }>
}

function sourceFilesUnder(directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sourceFilesUnder(path, into)
    else if (/\.tsx?$/.test(entry.name)) into.push(path)
  }
  return into
}

function slice(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  assert.notEqual(start, -1, `${from} must exist`)
  const end = text.indexOf(to, start)
  assert.notEqual(end, -1, `${to} must exist after ${from}`)
  return text.slice(start, end)
}

const tableRows = read(DOC_PATH)
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
  )
  .filter((cells) => cells.length === 4 && cells[0] !== 'id' && !/^-+$/.test(cells[0]))

assert.ok(tableRows.length > 0, `${DOC_PATH} must carry the status table`)
const rows = new Map<string, { scope: string; status: string; evidence: string }>()
for (const [id, scope, status, evidence] of tableRows) {
  assert.ok(!rows.has(id), `row ${id} appears twice in ${DOC_PATH}`)
  assert.ok(
    Object.prototype.hasOwnProperty.call(REQUIRED_ROWS, id),
    `row ${id} is not a gate row; add it to this verifier deliberately or drop it from the table`
  )
  assert.equal(scope, REQUIRED_ROWS[id], `row ${id} must be scope ${REQUIRED_ROWS[id]}`)
  assert.ok(
    ['pass', 'pending', 'fail'].includes(status),
    `row ${id} has status ${status}; only pass, pending or fail are allowed`
  )
  assert.ok(evidence.length >= 12, `row ${id} needs evidence a reviewer can check`)
  rows.set(id, { scope, status, evidence })
}
for (const id of Object.keys(REQUIRED_ROWS)) {
  assert.ok(rows.has(id), `${DOC_PATH} is missing the ${id} row`)
}

/**
 * A static row is one the source proves on every CI run, so it may never sit at `pending`, and the
 * run fails naming the row the moment its proof stops holding — the table cannot rot silently.
 */
function prove(id: string, check: () => void): void {
  const row = rows.get(id)
  assert.ok(row, `${DOC_PATH} must carry the ${id} row`)
  assert.equal(
    row.status,
    'pass',
    `row ${id} is proven from source, so the table must not carry it as ${row.status}`
  )
  try {
    check()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert.fail(`${DOC_PATH} marks ${id} as pass, but the source no longer proves it: ${message}`)
  }
}

prove('argv-red-lines', () => {
  const flags = slice(argvBuilder, 'FORBIDDEN_ARGV_TOKENS', 'FORBIDDEN_COMMAND_NAMES')
  for (const flag of FORBIDDEN_FLAGS) {
    assert.ok(flags.includes(`'${flag}'`), `${flag} must stay on the argv forbidden list`)
  }
  const verbs = slice(argvBuilder, 'FORBIDDEN_COMMAND_NAMES', '] as const')
  for (const verb of FORBIDDEN_VERBS) {
    assert.ok(verbs.includes(`'${verb}'`), `${verb} must stay a forbidden command`)
  }
  assert.match(argvBuilder, /assertPlanIsAllowed/, 'argv must pass a gate before the spawn')
})

prove('headless-only', () => {
  assert.equal(
    (argvBuilder.match(/'--headed'/g) ?? []).length,
    1,
    '--headed may only appear as a forbidden token'
  )
  for (const [name, source] of [
    ['cli-client.ts', client],
    ['desktop-ax-runtime-tools.ts', tools]
  ] as const) {
    assert.ok(!/headed/.test(source), `${name} must never reach for headed mode`)
  }
})

prove('approval-before-mutation', () => {
  assert.match(tools, /effect: reader \? 'read' : 'write'/)
  assert.match(authorization, /if \(tool\.effect === 'read'\) return true/)
})

prove('unattended-refusal', () => {
  assert.match(
    authorization,
    /startsWith\('desktop_ax_'\)[\s\S]{0,60}return false/,
    'every accessibility write must be refused when no one is there to approve it'
  )
})

prove('backend-fail-closed', () => {
  assert.match(
    tools,
    /if \(!status\.available \|\| !status\.binaryPath\) return \[\]/,
    'a backend that is not fully available must register nothing'
  )
})

prove('allowlist-before-approval', () => {
  assert.match(tools, /assertAppAllowed\(app, options\.allowedApps\)/)
  assert.match(tools, /throw new RuntimeError\('AGENT_DESKTOP_APP_NOT_ALLOWED'\)/)
  assert.ok(
    tools.indexOf('prepare:') < tools.indexOf('execute:'),
    'the bound has to be checked ahead of the approval prompt'
  )
  assert.match(
    registration,
    /createDesktopAxRuntimeTools\(\{[\s\S]{0,120}allowedApps/,
    'an un-wired bound is an unenforced bound; Main must pass allowedApps at registration'
  )
  assert.match(
    registration,
    /resolveDesktopAxAllowedApps\(run\.projectId\)/,
    'the bound has to come from the plugin configuration only Main can read'
  )
})

prove('binary-integrity-pin', () => {
  assert.equal(Object.keys(lock.platforms).length, 6, 'the lock must pin six platform triples')
  for (const [key, entry] of Object.entries(lock.platforms)) {
    assert.ok(entry.cli && entry.binaries?.[entry.cli], `${key} must pin its own CLI`)
    for (const [name, pin] of Object.entries(entry.binaries)) {
      assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${key}/${name} must carry a sha256`)
    }
    if (key.startsWith('win32')) assert.equal(entry.cli, 'agent-desktop.exe', key)
  }
  assert.match(client, /agent-desktop binary hash changed/)
})

prove('result-budget-bound', () => {
  const digits = (value: string): number => Number(value.replace(/_/g, ''))
  const ceiling = digits(shrink.match(/SNAPSHOT_MAX_CHARS = ([\d_]+)/)?.[1] ?? '0')
  const clip = digits(rendererClip.match(/MAX_TOOL_OUTPUT_TEXT_CHARS = ([\d_]+)/)?.[1] ?? '0')
  assert.ok(
    ceiling > 0 && ceiling < clip,
    `the rendered snapshot must stay inside the renderer clip: ${ceiling} vs ${clip}`
  )
})

prove('guidance-when-unavailable', () => {
  assert.match(detector, /'wayland-unsupported'/, 'a Wayland-only session must be refused by name')
  assert.match(detector, /installHintCode/, 'every refusal must carry a codeable hint')
})

const namingFiles = sourceFilesUnder('src/renderer').filter((path) =>
  readFileSync(path, 'utf8').includes('desktop_ax_launch')
)
const whitelistOnly = namingFiles.every((path) => path.endsWith('ts-runtime-text-eligibility.ts'))

const openRows = [...rows.entries()].filter(([, row]) => row.status !== 'pass')
prove('lockdown-coupling', () => {
  if (openRows.length === 0) {
    assert.ok(
      namingFiles.length > 1,
      'every row passed but no product flow requests the tools; finish the unhide checklist'
    )
    return
  }
  assert.ok(
    whitelistOnly,
    `the gate is red while a product flow requests the tools: ${namingFiles.join(', ')}`
  )
  assert.match(
    descriptors,
    /hidden: true/,
    'the desktop plugin must stay hidden while the gate is red'
  )
  assert.match(pluginStore, /isDesktopControlToolAvailable: \(\) => false/)
  assert.match(pluginStore, /existing\.enabled = false/)
})

prove('ci-platform-coverage', () => {
  for (const step of ['npm run fetch:agent-desktop', 'npm run test:agent-desktop']) {
    const hits = workflow.split(step).length - 1
    assert.ok(hits >= 2, `${step} must run on more than one platform job`)
  }
  assert.ok(workflow.split('npm run verify:desktop-ax-gate').length - 1 >= 2)
})

/**
 * `@electron/osx-sign` walks the bundle but is not known to sign `app.asar.unpacked`, so the hook
 * signs the pinned CLI itself and the release verifier refuses a bundle where that never happened.
 */
prove('bundled-binary-signing', () => {
  assert.match(
    afterPack,
    /signAgentDesktopBinaries\(\{[\s\S]{0,200}identity: signingIdentity/,
    'afterPack must sign the nested CLI and helper with the identity used for the app'
  )
  assert.match(
    afterPack,
    /verifyAgentDesktopSignatures\(\{[\s\S]{0,200}requireSignature/,
    'afterPack must fail the pack when the signature it asked for is not on the binaries'
  )
  assert.match(
    releaseVerify,
    /await assertMacArtifact/,
    'release verification must open the artifact, not only read its name'
  )
  assert.match(
    releaseVerify,
    /verifyAgentDesktopSignatures\(\{[\s\S]{0,200}requireSignature/,
    'a release must refuse a bundle whose pinned binaries are unsigned or ad-hoc'
  )
  assert.match(
    macSign,
    /is only ad-hoc signed/,
    'an ad-hoc binary inside a signed bundle is a fail'
  )
  assert.match(macSign, /is not an \$\{architecture\} Mach-O/, 'the binary must match the app arch')
  assert.match(macSign, /signed by team/, 'the team must match the app')
  assert.match(
    macSign,
    /is missing from the bundle; run npm run fetch:agent-desktop/,
    'a bundle that lost its pinned binary must fail rather than register an unmet tool'
  )
})

prove('sbom-registration', () => {
  assert.match(sbomPins, /export (async )?function bundledBinaryComponents/)
  assert.match(sbomPins, /checksumsSha256/, 'the lock must be read, not restated')
  assert.match(sbomPins, /size/, 'each pinned file must carry its size')
  assert.match(
    releaseVerify,
    /await bundledBinaryComponents\(\)/,
    'the release SBOM must include the native binaries, not only the npm manifests'
  )
  assert.match(sbomWriter, /SPDXRef-Bundled-/, 'bundled components need their own package refs')
  assert.match(sbomWriter, /SPDXRef-BundledFile-/, 'bundled files must be listed, not implied')
  assert.match(sbomWriter, /licenseConcluded/, 'a bundled binary must state a concluded license')
})

if (strict) {
  const blocking = openRows.map(([id, row]) => `  ${id}: ${row.status}`)
  assert.ok(
    blocking.length === 0,
    `the acceptance gate is not green:\n${blocking.join('\n')}\nUnhide only after every row passes.`
  )
}

for (const name of AX_TOOL_NAMES) {
  assert.ok(eligibility.includes(`'${name}'`), `${name} must stay on the agent whitelist`)
}

const summary = openRows.length
  ? `${String(openRows.length)} of ${String(rows.size)} rows open`
  : `all ${String(rows.size)} rows pass`
console.log(`agent-desktop acceptance gate: ${summary}${strict ? ' (strict)' : ''}`)
