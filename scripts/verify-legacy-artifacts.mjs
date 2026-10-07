import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { isLegacyRuntimeArtifactPath } from './legacy-runtime-artifact-patterns.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')

const target = process.argv[2] ?? 'out'
const root = path.resolve(target)
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`Unpacked app root does not exist: ${root}`)
}

const findings = []
let count = 0
let archiveEntryCount = 0
const queue = [root]
while (queue.length) {
  const directory = queue.pop()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) queue.push(filename)
    else if (entry.isFile()) {
      count++
      if (isLegacyRuntimeArtifactPath(path.relative(root, filename))) {
        findings.push(path.relative(root, filename))
      }
      if (entry.name === 'app.asar') {
        const entries = asar.listPackage(filename)
        archiveEntryCount += entries.length
        for (const archivePath of entries) {
          if (isLegacyRuntimeArtifactPath(archivePath)) {
            findings.push(`${path.relative(root, filename)}:${archivePath}`)
          }
        }
      }
    }
  }
}

console.log(
  `Inspected ${count} unpacked files and ${archiveEntryCount} app.asar entries under ${root}`
)
if (findings.length) {
  for (const filename of findings.slice(0, 25))
    console.error(`legacy runtime artifact: ${filename}`)
  if (findings.length > 25)
    console.error(`... ${findings.length - 25} more legacy runtime artifacts`)
  process.exitCode = 1
} else {
  console.log('No legacy runtime Worker or runtime artifacts found')
}
