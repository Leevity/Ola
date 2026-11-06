#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Capture REA's authoritative MCP tool inventory and emit tests/fixtures/rea-tools.json.
//
// The fixture is what makes the REA presets auditable: every preset is a literal name list drawn
// from a pinned inventory, never a runtime regex. Live capture is preferred, and the package's
// own recorded catalog is the documented fallback (the stdio server serves that same artifact).
//
//   node scripts/rea-tool-catalog.mjs --package /path/to/rea-agents [--live] [--out path]

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_OUT = join(REPO_ROOT, 'tests/fixtures/rea-tools.json')

// REA groups its tools by engine/contract module, and that module path is a far better category
// signal than any keyword scan of a name. Order is significant: the first match wins.
const MODULE_CATEGORY = [
  [/contracts\/(adb|android|apktool|apkSignature|flutter)\//, 'android'],
  [/contracts\/fridaToolContracts|\/jeb\//, 'android'],
  [/contracts\/(javascript|webScript|webRuntime|webNetworkCapture|browser|environment)/, 'web'],
  [/cliBrowserScenarioCommands/, 'web'],
  [/contracts\/javascript\//, 'javascript'],
  [/artifacts\/javascript\/|inspector\/JavaScriptRuntimeScope/, 'javascript'],
  [/contracts\/applicationToolContracts/, 'javascript'],
  [/contracts\/analysisViewToolContracts/, 'javascript'],
  [
    /contracts\/(native|managed|pcap|wasm|erlang|evm|sqlite|model|signals|gdb|cutter|reverseEngineering|rizinDebug|official|enhanced|functionWorkflow|session)/,
    'native'
  ],
  [/(^|\/)(hopper|native|firmware|gdb|go|gpu|python|rizin|pcap)\//, 'native'],
  [/artifacts\/ArtifactProvider|DesktopApplicationReader/, 'native'],
  [/contracts\/unknownContractExamples|config\/bridgeMaxRequestBytes|cliCommandNames/, 'native'],
  [/contracts\/promptContracts|toolEffects|mcpDoctor|cliEvidenceCommands/, 'core']
]

// Engines REA hands work off to. Detected from the contract module first, then from description
// text, because several tools name their engine in prose rather than in their identifier.
const ENGINE_BY_MODULE = [
  [/hopper\/|HopperClient|HopperOperationStage/, ['hopper', 'ghidra']],
  [
    /contracts\/(official|enhanced|functionWorkflow|session|prompt)ToolContracts|toolEffects/,
    ['hopper', 'ghidra', 'ida']
  ],
  [/cutter|rizin|objdump|reverseEngineering/, ['rizin']],
  [/gdb/, ['gdb']],
  [/contracts\/adb\//, ['adb']],
  [/contracts\/android\/|applicationToolContracts.*android|flutter|dart/, ['jadx']],
  [/apktool/, ['apktool']],
  [/frida/, ['frida']],
  [/jeb/, ['jeb']],
  [/pcap|TsharkCapture/, ['tshark']],
  [/firmware/, ['binwalk']],
  [/wasm/, ['wabt']],
  [/pwntools|PwntoolsLayout|RecordedCrash/, ['pwntools']],
  [/browser|webRuntime|webScript|webNetworkCapture|cliBrowserScenario/, ['chrome']],
  [/signals/, ['sigrok']],
  [/il2cpp|model|sqlite|gpu|go\/|python\/|erlang|evm|elf\/|pe\/|apple\/|devicetree|signature/, []]
]

const CATEGORY_ORDER = ['core', 'javascript', 'native', 'android', 'web']

function parseArgs(argv) {
  const args = { live: false, out: DEFAULT_OUT, package: process.env.REA_PACKAGE_DIR || '' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--live') args.live = true
    else if (token === '--package') args.package = argv[++index] ?? ''
    else if (token === '--out') args.out = argv[++index] ?? DEFAULT_OUT
    else if (token === '--help' || token === '-h') {
      console.log(
        'usage: node scripts/rea-tool-catalog.mjs --package <rea-agents dir> [--live] [--out <path>]'
      )
      process.exit(0)
    }
  }
  return args
}

/**
 * Locate the dist module that declares each advertised tool name. REA's own file layout is the
 * grouping we trust; a name regex over prose is not.
 */
async function buildModuleIndex(packageDir, wanted) {
  const files = (await globJs(join(packageDir, 'dist'))).filter((file) => file.endsWith('.js'))
  const index = new Map()
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/['"]([a-z][a-z0-9_]{2,60})['"]/g)) {
      const name = match[1]
      if (wanted.has(name) && !index.has(name)) index.set(name, file.replace(`${packageDir}/`, ''))
    }
  }
  return index
}

async function globJs(dir) {
  const { readdir } = await import('node:fs/promises')
  const found = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(path)
    }
  }
  return found
}

function categorize(modulePath, name, description) {
  for (const [pattern, category] of MODULE_CATEGORY) {
    if (pattern.test(modulePath)) return category
  }
  const haystack = `${name} ${description}`.toLowerCase()
  if (/android|apk|jadx|frida|adb/.test(haystack)) return 'android'
  if (/javascript|electron|asar/.test(haystack)) return 'javascript'
  if (/web|browser|http|pcap|packet/.test(haystack)) return 'web'
  if (/native|binary|macho|elf|pe|wasm|gdb|rizin|firmware/.test(haystack)) return 'native'
  return 'core'
}

function enginesFor(modulePath, name, description) {
  const found = new Set()
  for (const [pattern, engines] of ENGINE_BY_MODULE) {
    if (!pattern.test(modulePath)) continue
    for (const engine of engines) found.add(engine)
  }
  const haystack = `${name} ${description}`
  if (/Hopper/.test(haystack)) found.add('hopper')
  if (/Ghidra/.test(haystack)) found.add('ghidra')
  if (/\bIDA\b/.test(haystack)) found.add('ida')
  if (/JADX/.test(haystack)) found.add('jadx')
  if (/apktool/.test(haystack)) found.add('apktool')
  if (/Frida/.test(haystack)) found.add('frida')
  if (/JEB/.test(haystack)) found.add('jeb')
  if (/TShark|tshark|capinfos/.test(haystack)) found.add('tshark')
  if (/Binwalk|Unblob/.test(haystack)) found.add('binwalk')
  if (/WABT/.test(haystack)) found.add('wabt')
  if (/pwntools/.test(haystack)) found.add('pwntools')
  if (/sigrok/.test(haystack)) found.add('sigrok')
  if (/Rizin|Cutter/.test(haystack)) found.add('rizin')
  if (/\bGDB\b/.test(haystack)) found.add('gdb')
  if (/CDP|Chrome|browser/.test(haystack)) found.add('chrome')
  if (/\badb\b/.test(haystack)) found.add('adb')
  return [...found].sort()
}

async function readRecordedCatalog(packageDir) {
  const path = join(packageDir, 'dist/mcp-catalog.json')
  const text = await readFile(path, 'utf8')
  return JSON.parse(text)
}

// One JSON-RPC request per line over stdio, which is the MCP stdio framing.
function liveCatalog(packageDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(packageDir, 'scripts/rea.mjs'), 'mcp'], {
      cwd: packageDir,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(new Error('live tools/list timed out after 60s'))
    }, 60_000)
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ola-catalog', version: '1' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    ]
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 2 && message.result?.tools) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.kill('SIGKILL')
          resolvePromise({ tools: message.result.tools })
        }
        if (message.id === 2 && message.error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.kill('SIGKILL')
          rejectPromise(new Error(`tools/list error: ${JSON.stringify(message.error)}`))
        }
      }
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.package) {
    console.error('error: --package <installed rea-agents directory> is required')
    process.exit(1)
  }
  const packageDir = resolve(args.package)
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))

  let catalog
  let source = 'recorded'
  if (args.live) {
    try {
      catalog = await liveCatalog(packageDir)
      source = 'live'
    } catch (error) {
      console.warn(`live capture failed (${error.message}); falling back to the recorded catalog`)
    }
  }
  if (!catalog) catalog = await readRecordedCatalog(packageDir)

  const modules = await buildModuleIndex(
    packageDir,
    new Set(catalog.tools.map((tool) => tool.name))
  )
  const unmapped = catalog.tools.filter((tool) => !modules.has(tool.name)).map((tool) => tool.name)

  const tools = catalog.tools.map((tool) => {
    const description = String(tool.description ?? '')
    const modulePath = modules.get(tool.name) ?? ''
    const category = categorize(modulePath, tool.name, description)
    return {
      name: tool.name,
      module: modulePath.replace(/^dist\//, ''),
      category,
      engines: enginesFor(modulePath, tool.name, description),
      description: description.replace(/\s+/g, ' ').trim().slice(0, 400),
      readOnly: tool.annotations?.readOnlyHint === true
    }
  })

  const digest = createHash('sha256')
    .update(
      tools.map((tool) => `${tool.name}\u0000${tool.description}\u0000${tool.category}`).join('\n')
    )
    .digest('hex')

  const byCategory = {}
  for (const category of CATEGORY_ORDER) byCategory[category] = 0
  for (const tool of tools) byCategory[tool.category] = (byCategory[tool.category] ?? 0) + 1
  const overBudget = tools.filter((tool) => tool.name.length > 47).map((tool) => tool.name)

  const fixture = {
    server: {
      package: packageJson.name,
      version: packageJson.version,
      enginesNode: packageJson.engines?.node ?? '',
      catalogSource: source,
      recordedToolsSha256: catalog.identity?.digests?.tools_sha256 ?? '',
      inventorySha256: digest
    },
    count: tools.length,
    byCategory,
    overSegmentBudget: overBudget,
    unmappedModules: unmapped,
    tools: tools.sort((a, b) => a.name.localeCompare(b.name))
  }

  await mkdir(dirname(resolve(args.out)), { recursive: true })
  await writeFile(resolve(args.out), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  console.log(
    `wrote ${resolve(args.out)}: ${tools.length} tools from ${packageJson.name}@${packageJson.version} (${source})`
  )
  console.log(`categories: ${JSON.stringify(byCategory)}`)
  if (overBudget.length)
    console.log(`names over the 47-char segment budget: ${overBudget.join(', ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
