/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['bin', 'obj', 'node_modules'].includes(entry.name)) continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(filename)))
    else if (entry.isFile()) result.push(filename)
  }
  return result.sort()
}
const sourceRoots = [
  'sidecars/Ola.Native.Worker',
  'sidecars/Ola.CodeGraph.Core',
  'sidecars/Ola.CodeGraph.Worker'
]
const methods = []
const agentContractSource = await readFile(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeContract.g.cs',
  'utf8'
)
const agentContractRoutes = new Map(
  [...agentContractSource.matchAll(/public const string (\w+Route) = "([^"]+)";/g)].map((match) => [
    match[1],
    match[2]
  ])
)
const tsHandlerFiles = await files('src/main/ipc')
const tsRoutes = new Set()
for (const filename of tsHandlerFiles) {
  if (!filename.endsWith('.ts')) continue
  const content = await readFile(filename, 'utf8')
  for (const match of content.matchAll(/['"]([a-z][a-z0-9-]*[:/][a-z0-9-]+)['"]/g)) {
    tsRoutes.add(match[1].replace(':', '/'))
  }
}
for (const root of sourceRoots) {
  for (const filename of await files(root)) {
    if (!filename.endsWith('.cs')) continue
    const content = await readFile(filename, 'utf8')
    for (const match of content.matchAll(
      /\.Register\(\s*(?:"([^"]+)"|AgentRuntimeContract\.(\w+Route))/g
    )) {
      const method = match[1] ?? agentContractRoutes.get(match[2])
      if (!method) throw new Error(`Unresolved route constant ${match[2]} in ${filename}`)
      methods.push({
        method,
        source: filename,
        line: content.slice(0, match.index).split('\n').length,
        status: tsRoutes.has(match[1]) ? 'staged-ts' : 'legacy'
      })
    }
  }
}
const manifest = JSON.parse(await readFile('src/shared/codegraph-grammars.json', 'utf8'))
const output = {
  schemaVersion: 1,
  notes:
    'Static registrations plus resolved AgentRuntimeContract route constants. staged-ts means a route literal also appears in Main IPC source; it is not proof of parity or production cutover. Compare with live worker/routes before cutover.',
  routes: methods.sort(
    (a, b) => a.method.localeCompare(b.method) || a.source.localeCompare(b.source)
  ),
  codegraphLanguages: manifest.grammars.flatMap((grammar) =>
    grammar.languages.map((language) => ({
      id: language.id,
      library: grammar.library,
      status: 'legacy'
    }))
  )
}
const destination = 'docs/migrations/ts-runtime/capability-inventory.json'
await mkdir(path.dirname(destination), { recursive: true })
await writeFile(destination, JSON.stringify(output, null, 2) + '\n')
console.log(
  `${methods.length} registered routes; ${tsRoutes.size} Main IPC literals; ${output.codegraphLanguages.length} grammar language ids`
)
