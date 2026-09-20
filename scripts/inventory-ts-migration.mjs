/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'out', 'dist'].includes(entry.name)) continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(filename)))
    else if (entry.isFile()) result.push(filename)
  }
  return result.sort()
}

const routes = []
for (const filename of await files('src/main/ipc')) {
  if (!filename.endsWith('.ts')) continue
  const content = await readFile(filename, 'utf8')
  for (const match of content.matchAll(/['"]([a-z][a-z0-9-]*[:/][a-z0-9-]+)['"]/g)) {
    routes.push({
      method: match[1].replace(':', '/'),
      source: filename,
      line: content.slice(0, match.index).split('\n').length,
      status: 'ts-runtime'
    })
  }
}
const manifest = JSON.parse(await readFile('src/shared/codegraph-grammars.json', 'utf8'))
const output = {
  schemaVersion: 2,
  notes: 'Inventory of TypeScript-owned IPC routes and CodeGraph WASM language identifiers.',
  routes: routes.sort((a, b) => a.method.localeCompare(b.method)),
  codegraphLanguages: manifest.grammars.flatMap((grammar) =>
    grammar.languages.map((language) => ({
      id: language.id,
      library: grammar.library,
      status: 'ts-wasm'
    }))
  )
}
const destination = 'docs/migrations/ts-runtime/capability-inventory.json'
if (process.argv.includes('--write')) {
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(output, null, 2) + '\n')
} else {
  console.log('read-only inventory; pass --write to replace the frozen capability inventory')
}
console.log(
  `${output.routes.length} TS routes; ${output.codegraphLanguages.length} WASM language ids`
)
