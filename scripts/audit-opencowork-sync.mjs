/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(import.meta.dirname, '..')
const defaultReferenceRoot = path.resolve(repoRoot, '..', 'OpenCowork')
const outputDir = path.join(repoRoot, 'docs', 'sync-audit')
const baselinePath = path.join(outputDir, 'baseline.json')
const summaryPath = path.join(outputDir, 'SUMMARY.md')
const pinnedReferenceCommit = '18413c22a498a26748fa28dfcc05a24df8787ad8'

const includedRoots = [
  'src/main',
  'src/preload',
  'src/renderer/src',
  'src/shared',
  'sidecars',
  'scripts'
]
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.cs', '.csproj'])
const ignoredSegments = new Set(['node_modules', 'bin', 'obj', 'out', 'dist', '.git', '.DS_Store'])

const capabilityDomains = [
  {
    name: 'CodeGraph',
    decision: 'adapt',
    reason: 'Adopt as an opt-in Ola worker with verified assets and a staged rollout.',
    patterns: [/codegraph/i, /tree-sitter/i, /grammar/i]
  },
  {
    name: 'Hooks',
    decision: 'adapt',
    reason:
      'Adopt only after permission policy, with hash-bound trust and local execution defaults.',
    patterns: [/(^|[/.-])hooks?([/.-]|$)/i]
  },
  {
    name: 'SSH',
    decision: 'adapt',
    reason: 'Reuse modular state and management capabilities inside the Ola remote workbench.',
    patterns: [/(^|[/.-])ssh([/.-]|$)/i, /sftp/i, /known.?hosts/i, /port.?forward/i]
  },
  {
    name: 'Agent',
    decision: 'adapt',
    reason:
      'Review runtime, history, permissions, retries, drafts, and execution UX as vertical slices.',
    patterns: [/agent/i, /permission/i, /input-draft/i, /content-block/i, /execution-outline/i]
  },
  {
    name: 'Media',
    decision: 'defer',
    reason: 'Defer video generation until the Ola product roadmap explicitly requires it.',
    patterns: [/media/i, /video/i, /seedance/i, /xai/i]
  },
  {
    name: 'Distribution',
    decision: 'adapt',
    reason:
      'Adopt asset integrity and updater improvements while preserving Ola packaging and channels.',
    patterns: [/distribution/i, /updat(e|er)/i, /release/i, /publish/i, /portable/i]
  }
]

const fallbackDomain = {
  name: 'Other',
  decision: 'defer',
  reason: 'Requires an explicit capability review before adoption.'
}

function parseArgs(argv) {
  const configuredReference = process.env.OPEN_COWORK_REFERENCE
  const args = {
    reference: configuredReference ? path.resolve(configuredReference) : defaultReferenceRoot,
    referenceConfigured: Boolean(configuredReference),
    write: false,
    check: false,
    json: false,
    markdown: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--reference') {
      const reference = argv[++index]
      if (!reference) throw new Error('--reference requires a directory')
      args.reference = path.resolve(reference)
      args.referenceConfigured = true
    } else if (value === '--write') args.write = true
    else if (value === '--check') args.check = true
    else if (value === '--json') args.json = true
    else if (value === '--markdown') args.markdown = true
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
    .replaceAll('Ola.CodeGraph.Worker', '{PRODUCT}.CodeGraph.Worker')
    .replaceAll('OpenCowork.CodeGraph.Worker', '{PRODUCT}.CodeGraph.Worker')
    .replaceAll('/CodeGraph/Core/', '/CodeGraph/{CORE}/')
    .replaceAll('/CodeGraph/Worker/', '/CodeGraph/{WORKER}/')
    .replaceAll('/CodeGraph/Tests/', '/CodeGraph/{TESTS}/')
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
      buckets.brandOnly.push({
        canonicalPath: key,
        olaPath: ola.path,
        referencePath: reference.path
      })
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
    /ipcRenderer\.(?:invoke|send|sendSync)\(\s*["']([^"']+)["']/g
  ])
  const settingsTabs = collectMatches(sources, [
    /type SettingsTab\s*=([\s\S]*?)(?:\n\n|;)/g
  ]).flatMap((block) => [...block.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]))
  const nativeModules = sources
    .filter(
      ({ relativePath, content }) =>
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

function groupReferenceCandidates(files) {
  const groups = Object.fromEntries(
    [...capabilityDomains, fallbackDomain].map(({ name, decision, reason }) => [
      name,
      { decision, reason, count: 0, files: [] }
    ])
  )
  for (const file of files) {
    const searchablePath = `${file.canonicalPath} ${file.referencePath}`
    const domain = capabilityDomains.find(({ patterns }) =>
      patterns.some((pattern) => pattern.test(searchablePath))
    )
    const group = groups[domain?.name ?? fallbackDomain.name]
    group.files.push(file)
    group.count += 1
  }
  return groups
}

function escapeMarkdown(value) {
  return value.replaceAll('|', '\\|')
}

function renderMarkdown(audit) {
  const lines = [
    '# OpenCowork sync audit summary',
    '',
    '> Generated by `npm run audit:sync:write`. Do not edit manually.',
    '',
    `- Ola: ${audit.baseline.ola.version}`,
    `- OpenCowork: ${audit.baseline.reference.version} (${audit.baseline.reference.commit})`,
    `- Reference fingerprint: \`${audit.baseline.reference.sourceFingerprint}\``,
    '',
    '## File comparison',
    '',
    '| Classification | Count |',
    '| --- | ---: |',
    ...Object.entries(audit.summary.files).map(([name, count]) => `| ${name} | ${count} |`),
    '',
    '## Reference-only capability candidates',
    '',
    '| Domain | Decision | Files | Rationale |',
    '| --- | --- | ---: | --- |',
    ...Object.entries(audit.capabilities).map(
      ([name, group]) =>
        `| ${name} | ${group.decision} | ${group.count} | ${escapeMarkdown(group.reason)} |`
    ),
    '',
    'The JSON baseline is the machine-readable gate. Candidate decisions are review metadata, not',
    'permission to copy reference files.',
    ''
  ]
  return lines.join('\n')
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
    Object.keys(olaCatalog).map((key) => [
      key,
      compareLists(olaCatalog[key], referenceCatalog[key])
    ])
  )
  return {
    schemaVersion: 2,
    baseline: {
      ola: {
        version: await readPackageVersion(repoRoot),
        sourceFingerprint: fingerprintFiles(olaFiles)
      },
      reference: {
        product: 'OpenCowork',
        version: await readPackageVersion(referenceRoot),
        commit: await readGitHead(referenceRoot),
        pinnedCommit: pinnedReferenceCommit,
        sourceFingerprint: fingerprintFiles(referenceFiles),
        pathHint: '../OpenCowork'
      }
    },
    scope: includedRoots,
    summary: { files: summarizeFiles(files) },
    capabilities: groupReferenceCandidates(files.onlyReference),
    files,
    catalog
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(path.join(args.reference, 'package.json'))) {
    const mode = args.referenceConfigured ? 'configured' : 'default sibling'
    console.log(`Skipping OpenCowork sync audit: ${mode} reference not found at ${args.reference}`)
    return
  }
  const audit = await buildAudit(args.reference)
  if (audit.baseline.reference.commit !== pinnedReferenceCommit) {
    throw new Error(
      `OpenCowork reference must be pinned to ${pinnedReferenceCommit}; found ${audit.baseline.reference.commit}`
    )
  }
  const json = stableJson(audit)
  const markdown = renderMarkdown(audit)
  if (args.write) {
    await mkdir(outputDir, { recursive: true })
    await Promise.all([
      writeFile(baselinePath, json, 'utf8'),
      writeFile(summaryPath, markdown, 'utf8')
    ])
    console.log(
      `Wrote ${path.relative(repoRoot, baselinePath)} and ${path.relative(repoRoot, summaryPath)}`
    )
  }
  if (args.check) {
    const [currentJson, currentMarkdown] = await Promise.all([
      readFile(baselinePath, 'utf8'),
      readFile(summaryPath, 'utf8')
    ])
    if (currentJson !== json || currentMarkdown !== markdown)
      throw new Error('Sync audit baseline is stale. Run npm run audit:sync:write')
    console.log('sync audit baseline is current')
  }
  if (args.json) process.stdout.write(json)
  else if (args.markdown) process.stdout.write(markdown)
  else if (!args.write && !args.check) console.table(audit.summary.files)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

export { capabilityDomains, extractCatalog, groupReferenceCandidates, parseArgs, renderMarkdown }
