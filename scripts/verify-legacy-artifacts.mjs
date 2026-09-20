import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const target = process.argv[2] ?? 'out'
const root = path.resolve(target)
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`Unpacked app root does not exist: ${root}`)
}

const forbidden = [
  /^Ola\.Native\.Worker(?:\.exe)?$/i,
  /^Ola\.CodeGraph\.Worker(?:\.exe)?$/i,
  /^Ola\.(?:Native|CodeGraph|Worker)\.[^/]*\.dll$/i,
  /\.runtimeconfig\.json$/i,
  /\.deps\.json$/i,
  /^hostfxr(?:\.dll|\.so|\.dylib)?$/i,
  /^hostpolicy(?:\.dll|\.so|\.dylib)?$/i
]
const findings = []
let count = 0
const queue = [root]
while (queue.length) {
  const directory = queue.pop()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) queue.push(filename)
    else if (entry.isFile()) {
      count++
      if (forbidden.some((pattern) => pattern.test(entry.name))) {
        findings.push(path.relative(root, filename))
      }
    }
  }
}

console.log(`Inspected ${count} unpacked files under ${root}`)
if (findings.length) {
  for (const filename of findings.slice(0, 25))
    console.error(`legacy runtime artifact: ${filename}`)
  if (findings.length > 25)
    console.error(`... ${findings.length - 25} more legacy runtime artifacts`)
  process.exitCode = 1
} else {
  console.log('No legacy runtime Worker or runtime artifacts found')
}
