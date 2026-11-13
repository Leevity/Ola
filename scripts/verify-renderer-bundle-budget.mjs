import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// First-paint cost is the entry chunk plus the STATIC closure of whichever window
// root main.tsx selects. The entry reaches those roots through dynamic import, so
// an entry-only measurement understates the real cost by an order of magnitude.
// Deeper dynamic imports are genuinely lazy and are not walked.
//
// Edges and library attribution come from Rollup's module graph, emitted by the
// ola-bundle-manifest plugin. Sniffing minified code for library names reports
// locale strings and tokenizer vocabulary as hits.
const manifestPath = resolve('out/bundle-manifest.json')
const rendererDir = resolve('out/renderer')

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch {
  assert.fail(
    `${manifestPath} is missing. Run \`npm run build\` first; the renderer build emits it.`
  )
}

const chunks = new Map(manifest.chunks.map((c) => [c.fileName, c]))

function staticClosure(rootNames) {
  const seen = new Set()
  const queue = [...rootNames]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name) || !chunks.has(name)) continue
    seen.add(name)
    for (const dep of chunks.get(name).imports) if (!seen.has(dep)) queue.push(dep)
  }
  return seen
}

const bytesOf = (names) => [...names].reduce((t, n) => t + (chunks.get(n)?.bytes ?? 0), 0)

// A package is attributed by its module path, so a translated string that happens
// to contain "noVNC" can never be mistaken for the library.
const HEAVY_PACKAGES = [
  'mermaid',
  'recharts',
  'react-syntax-highlighter',
  'refractor',
  'prismjs',
  'monaco-editor',
  '@monaco-editor',
  '@codemirror',
  '@lezer',
  'ironrdp-wasm',
  '@novnc/novnc',
  'katex',
  'xlsx',
  'pdfjs-dist',
  'gpt-tokenizer'
]

function heavyPackages(names) {
  const hits = new Map()
  for (const name of names) {
    for (const mod of chunks.get(name)?.modules ?? []) {
      const pkg = HEAVY_PACKAGES.find((p) => mod.id.includes(`/node_modules/${p}/`))
      if (!pkg) continue
      if (!hits.has(pkg)) hits.set(pkg, { bytes: 0, chunks: new Set() })
      const hit = hits.get(pkg)
      hit.bytes += mod.bytes
      hit.chunks.add(name)
    }
  }
  return hits
}

const html = await readFile(join(rendererDir, 'index.html'), 'utf8')
const entries = [...html.matchAll(/<script[^>]+src="\.?\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1])
assert.ok(entries.length > 0, 'out/renderer/index.html must reference at least one entry script')
for (const entry of entries) {
  assert.ok(chunks.has(entry), `${entry} is referenced by index.html but absent from the manifest`)
}

const entryClosure = staticClosure(entries)

// The entry also reaches the lazy locale chunks by dynamic import, so "every dynamic
// import of the entry" is not the set of windows. Name the three roots main.tsx can
// select and resolve them through the module graph instead.
const WINDOW_ROOT_MODULES = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/notify/NotifyWindow.tsx',
  'src/renderer/src/components/pet/PetWindow.tsx'
]

const entryDynamic = new Set(entries.flatMap((e) => chunks.get(e)?.dynamicImports ?? []))
const roots = WINDOW_ROOT_MODULES.map((modulePath) => {
  const owner = [...chunks.values()].find((chunk) =>
    chunk.modules.some((mod) => mod.id.replaceAll('\\', '/').endsWith(modulePath))
  )
  assert.ok(owner, `no renderer chunk contains ${modulePath}`)
  assert.ok(
    entryDynamic.has(owner.fileName),
    `${modulePath} must stay behind a dynamic import in main.tsx; ` +
      `${owner.fileName} is now reachable without one, so every window would pay for it`
  )
  return owner.fileName
})

const windows = roots.map((root) => {
  const names = new Set([...entryClosure, ...staticClosure([root])])
  return { root, names, bytes: bytesOf(names), hits: heavyPackages(names) }
})
windows.sort((a, b) => b.bytes - a.bytes)
const worst = windows[0]

if (process.argv.includes('--report')) {
  console.log(
    `entry: ${entries.join(', ')} (${bytesOf(entryClosure)} bytes, ${entryClosure.size} chunks)`
  )
  console.log(`all renderer chunks: ${chunks.size}`)
  console.log('\nper-window first-paint cost (entry + root static closure):')
  for (const w of windows) {
    console.log(
      `  ${String(w.bytes).padStart(9)} bytes  ${String(w.names.size).padStart(3)} chunks  ${w.root}`
    )
    const libs = [...w.hits.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([pkg, hit]) => `${pkg}(${hit.bytes})`)
    console.log(`      heavy: ${libs.length > 0 ? libs.join(' ') : '(none)'}`)
  }
  console.log(`\nlargest window (${worst.root}) closure chunks:`)
  for (const name of [...worst.names].sort((a, b) => chunks.get(b).bytes - chunks.get(a).bytes)) {
    console.log(`  ${String(chunks.get(name).bytes).padStart(9)}  ${name}`)
  }
  console.log(`\nlargest packages in ${worst.root}:`)
  const byPackage = new Map()
  for (const name of worst.names) {
    for (const mod of chunks.get(name).modules) {
      const match = mod.id.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
      const key = match ? match[1] : '(app source)'
      byPackage.set(key, (byPackage.get(key) ?? 0) + mod.bytes)
    }
  }
  for (const [pkg, bytes] of [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(bytes).padStart(9)}  ${pkg}`)
  }
  process.exit(0)
}

// Ceilings come from the measured post-optimization baseline plus headroom, not
// from a guess. Raising one requires a recorded justification in docs/qa/.
// 2026-11-12 baseline: App 4,178,047 bytes / 5 chunks (docs/qa/2026-11-12-perf-baseline.md).
const MAX_BYTES = Number(process.env.OLA_MAX_FIRST_PAINT_BYTES ?? 4_600_000)
const MAX_CHUNKS = Number(process.env.OLA_MAX_FIRST_PAINT_CHUNKS ?? 16)
// katex stays eager on purpose: its plugin constants sit on the streaming hot path,
// so a lazy boundary there costs more than the bytes it saves.
const ALLOWED_HEAVY = new Set(
  (process.env.OLA_FIRST_PAINT_ALLOW ?? 'katex').split(',').filter(Boolean)
)

const failures = []
if (worst.bytes > MAX_BYTES) {
  failures.push(
    `window ${worst.root} paints ${worst.bytes} bytes, over the ${MAX_BYTES} byte budget`
  )
}
if (worst.names.size > MAX_CHUNKS) {
  failures.push(
    `window ${worst.root} paints ${worst.names.size} chunks, over the ${MAX_CHUNKS} chunk budget`
  )
}
for (const [pkg, hit] of worst.hits) {
  if (ALLOWED_HEAVY.has(pkg)) continue
  failures.push(
    `${pkg} contributes ${hit.bytes} bytes to the first-paint closure of ${worst.root} ` +
      `(${[...hit.chunks].join(', ')}); it must stay behind a lazy boundary`
  )
}

// The editor swap is only a win if Monaco is gone from the whole build, not just
// from first paint: one stray static import would put 3.8 MB back into the editor.
const monacoModules = [...chunks.values()].flatMap((chunk) =>
  chunk.modules.filter((mod) => /\/node_modules\/(monaco-editor|@monaco-editor)\//.test(mod.id))
)
if (monacoModules.length > 0) {
  failures.push(
    `monaco is still bundled (${monacoModules.length} modules, e.g. ${monacoModules[0].id}); ` +
      'the editor is CodeMirror 6 now'
  )
}

// 2026-11-12 measured: the CM6 engine chunk is 422,081 bytes against Monaco's
// 3,792,663-byte setup chunk, and the TS worker is 6,754,263 bytes against
// Monaco's 7,010,026-byte ts.worker. The worker ceiling is that Monaco number:
// the swap must never make the expensive case worse.
const MAX_EDITOR_ENGINE_BYTES = Number(process.env.OLA_MAX_EDITOR_ENGINE_BYTES ?? 600_000)
const MAX_TS_WORKER_BYTES = Number(process.env.OLA_MAX_TS_WORKER_BYTES ?? 7_010_026)

const engineChunks = [...chunks.values()].filter((chunk) =>
  chunk.modules.some((mod) => mod.id.includes('/node_modules/@codemirror/view/'))
)
const engineBytes = engineChunks.reduce((total, chunk) => total + chunk.bytes, 0)
if (engineBytes > MAX_EDITOR_ENGINE_BYTES) {
  failures.push(
    `the CodeMirror engine paints ${engineBytes} bytes (${engineChunks
      .map((c) => c.fileName)
      .join(', ')}), over the ${MAX_EDITOR_ENGINE_BYTES} byte editor budget`
  )
}

const workerAssets = (await readdir(join(rendererDir, 'assets'))).filter((name) =>
  /^ts-language-worker-.*\.js$/.test(name)
)
let tsWorkerBytes = 0
if (workerAssets.length !== 1) {
  failures.push(
    `expected exactly one TypeScript language worker asset, found ${workerAssets.length}`
  )
} else {
  tsWorkerBytes = (await readFile(join(rendererDir, 'assets', workerAssets[0]))).byteLength
  if (tsWorkerBytes > MAX_TS_WORKER_BYTES) {
    failures.push(
      `${workerAssets[0]} is ${tsWorkerBytes} bytes, over the ${MAX_TS_WORKER_BYTES} byte ceiling ` +
        'left by the Monaco ts.worker it replaced'
    )
  }
}

assert.equal(
  failures.length,
  0,
  `renderer bundle budget exceeded:\n  - ${failures.join('\n  - ')}\n` +
    'Run `node scripts/verify-renderer-bundle-budget.mjs --report` for the breakdown.'
)

console.log(
  `Renderer bundle budget passed: worst window ${worst.root} paints ${worst.bytes} bytes across ${worst.names.size} chunks`
)
console.log(
  `Editor cost: CodeMirror engine ${engineBytes} bytes, TypeScript worker ${tsWorkerBytes} bytes, monaco modules ${monacoModules.length}`
)
