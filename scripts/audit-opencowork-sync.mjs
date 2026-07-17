import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const defaultReferenceRoot = path.resolve(repoRoot, '..', 'OpenCowork')
const outputDir = path.join(repoRoot, 'docs', 'sync-audit')
const baselinePath = path.join(outputDir, 'baseline.json')

const includedRoots = [
  'src/main',
  'src/preload',
  'src/renderer/src',
  'src/shared',
  'sidecars',
  'scripts'
]
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.cs', '.csproj'])
const ignoredSegments = new Set(['node_modules', 'bin', 'obj', 'out', 'dist', '.git'])

function parseArgs(argv) {
  const args = { reference: defaultReferenceRoot, write: false, check: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--reference') args.reference = path.resolve(argv[++index])
    else if (value === '--write') args.write = true
    else if (value === '--check') args.check = true
    else if (value === '--json') args.json = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  return args
}

async function listFiles(root) {
  const files = []
  async function visit(relativeDir) {
    const absoluteDir = path.join(root, relativeDir)
    if (!existsSync(absoluteDir)) return
    const entries = await readdir(absoluteDir, { withFileTypes: true })
    for (const entry of entries) {
      if (ignoredSegments.has(entry.name)) continue
      const relativePath = path.join(relativeDir, entry.name)
      if (entry.isDirectory()) await visit(relativePath)
      else if (sourceExtensions.has(path.extname(entry.name))) {
        files.push(relativePath.replaceAll('\\', '/'))
      }
    }
  }
  for (const includedRoot of includedRoots) await visit(includedRoot)
  return files.sort()
}

function canonicalPath(relativePath) {
  return relativePath
    .replaceAll('Ola.Native.Worker', '{PRODUCT}.Native.Worker')
    .replaceAll('OpenCowork.Native.Worker', '{PRODUCT}.Native.Worker')
}

function normalizeBrand(content) {
  return content
    .replaceAll('OpenCowork', '{PRODUCT}')
    .replaceAll('open-cowork', '{product-kebab}')
    .replaceAll('OPEN_COWORK', '{PRODUCT_ENV}')
    .replaceAll('Ola', '{PRODUCT}')
    .replaceAll('ola', '{product-kebab}')
    .replaceAll('OLA', '{PRODUCT_ENV}')
    .replaceAll('\r\n', '\n')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function buildFileMap(root) {
  const result = new Map()
  for (const relativePath of await listFiles(root)) {
    const content = await readFile(path.join(root, relativePath), 'utf8')
    const key = canonicalPath(relativePath)
    result.set(key, {
      path: relativePath,
      hash: sha256(content),
      normalizedHash: sha256(normalizeBrand(content))
    })
  }
  return result
}

function compareFiles(olaFiles, referenceFiles) {
  const keys = [...new Set([...olaFiles.keys(), ...referenceFiles.keys()])].sort()
  const buckets = {
    identical: [],
    brandOnly: [],
    changed: [],
    onlyOla: [],
    onlyReference: []
  }
  for (const key of keys) {
    const ola = olaFiles.get(key)
    const reference = referenceFiles.get(key)
    if (!ola) buckets.onlyReference.push({ canonicalPath: key, referencePath: reference.path })
    else if (!reference) buckets.onlyOla.push({ canonicalPath: key, olaPath: ola.path })
    else if (ola.hash === reference.hash) buckets.identical.push({ canonicalPath: key })
    else if (ola.normalizedHash === reference.normalizedHash) {
      buckets.brandOnly.push({ canonicalPath: key, olaPath: ola.path, referencePath: reference.path })
    } else {
      buckets.changed.push({ canonicalPath: key, olaPath: ola.path, referencePath: reference.path })
    }
  }
  return buckets
}

async function readSourceFiles(root) {
  const sources = []
  for (const relativePath of await listFiles(root)) {
    sources.push({ relativePath, content: await readFile(path.join(root, relativePath), 'utf8') })
  }
  return sources
}

function collectMatches(sources, patterns) {
  const values = new Set()
  for (const { content } of sources) {
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) values.add(match[1])
    }
  }
  return [...values].sort()
}

function extractCatalog(sources) {
  const nativeRoutes = collectMatches(sources, [/context\.Register\(\s*["']([^"']+)["']/g])
  const ipcChannels = collectMatches(sources, [
    /ipcMain\.(?:handle|on)\(\s*(?:toMessagePackChannel\()?\s*["']([^"']+)["']/g,
    /ipcClient\.(?:invoke|send)\(\s*["']([^"']+)["']/g,
    /channel:\s*["']([^"']+)["']/g
  ])
  const settingsTabs = collectMatches(sources, [
    /type SettingsTab\s*=([\s\S]*?)(?:\n\n|;)/g
  ]).flatMap((block) => [...block.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]))
  const nativeModules = sources
    .filter(({ relativePath, content }) =>
      relativePath.includes('/Modules/') && /class\s+\w+Module\b/.test(content)
    )
    .map(({ relativePath }) => relativePath.split('/Modules/')[1].split('/')[0])
  return {
    ipcChannels: [...new Set(ipcChannels)].sort(),
    nativeRoutes,
    dbRoutes: nativeRoutes.filter((route) => route.startsWith('db/')),
    settingsTabs: [...new Set(settingsTabs)].sort(),
    nativeModules: [...new Set(nativeModules)].sort()
  }
}

function compareLists(ola, reference) {
  const olaSet = new Set(ola)
  const referenceSet = new Set(reference)
  return {
    shared: ola.filter((value) => referenceSet.has(value)),
    onlyOla: ola.filter((value) => !referenceSet.has(value)),
    onlyReference: reference.filter((value) => !olaSet.has(value))
  }
}

async function readPackageVersion(root) {
  const content = await readFile(path.join(root, 'package.json'), 'utf8')
  return content.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? 'unknown'
}

async function readGitHead(root) {
  try {
    const gitDir = path.join(root, '.git')
    const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    if (!head.startsWith('ref: ')) return head
    const ref = head.slice(5)
    return (await readFile(path.join(gitDir, ref), 'utf8')).trim()
  } catch {
    return 'unavailable'
  }
}

function summarizeFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.length]))
}

function fingerprintFiles(files) {
  const rows = [...files.entries()].map(([key, value]) => `${key}:${value.normalizedHash}`)
  return sha256(rows.sort().join('\n'))
}

async function buildAudit(referenceRoot) {
  if (!existsSync(path.join(referenceRoot, 'package.json'))) {
    throw new Error(`OpenCowork reference not found: ${referenceRoot}`)
  }
  const [olaFiles, referenceFiles, olaSources, referenceSources] = await Promise.all([
    buildFileMap(repoRoot),
    buildFileMap(referenceRoot),
    readSourceFiles(repoRoot),
    readSourceFiles(referenceRoot)
  ])
  const files = compareFiles(olaFiles, referenceFiles)
  const olaCatalog = extractCatalog(olaSources)
  const referenceCatalog = extractCatalog(referenceSources)
  const catalog = Object.fromEntries(
    Object.keys(olaCatalog).map((key) => [key, compareLists(olaCatalog[key], referenceCatalog[key])])
  )
  return {
    schemaVersion: 1,
    baseline: {
      ola: {
        version: await readPackageVersion(repoRoot),
        sourceFingerprint: fingerprintFiles(olaFiles)
      },
      reference: {
        product: 'OpenCowork',
        version: await readPackageVersion(referenceRoot),
        commit: await readGitHead(referenceRoot),
        pathHint: '../OpenCowork'
      }
    },
    scope: includedRoots,
    summary: { files: summarizeFiles(files) },
    files,
    catalog
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const audit = await buildAudit(args.reference)
  const json = stableJson(audit)
  if (args.write) {
    await mkdir(outputDir, { recursive: true })
    await writeFile(baselinePath, json, 'utf8')
    console.log(`Wrote ${path.relative(repoRoot, baselinePath)}`)
  }
  if (args.check) {
    const current = await readFile(baselinePath, 'utf8')
    if (current !== json) throw new Error('Sync audit baseline is stale. Run npm run audit:sync:write')
    console.log('sync audit baseline is current')
  }
  if (args.json) process.stdout.write(json)
  else if (!args.write && !args.check) console.table(audit.summary.files)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
