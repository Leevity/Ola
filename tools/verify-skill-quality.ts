import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(target)))
    else if (entry.isFile()) files.push(target)
  }
  return files
}

const root = path.resolve('resources/skills')
const entries = await readdir(root, { withFileTypes: true })
const skillNames = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

assert(skillNames.length > 0, 'expected bundled skills')

for (const folderName of skillNames) {
  const manifestPath = path.join(root, folderName, 'SKILL.md')
  const content = await readFile(manifestPath, 'utf8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert(match, `${folderName}: missing YAML frontmatter`)

  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    assert(separator > 0, `${folderName}: invalid frontmatter line`)
    const key = line.slice(0, separator).trim()
    assert(['name', 'description'].includes(key), `${folderName}: unsupported field ${key}`)
    fields.set(key, line.slice(separator + 1).trim())
  }

  assert.equal(fields.get('name'), folderName, `${folderName}: name must match folder`)
  assert(fields.get('description'), `${folderName}: description is required`)
  assert.match(folderName, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${folderName}: invalid name`)

  const body = content.slice(match[0].length)
  assert(body.split(/\r?\n/).length <= 500, `${folderName}: instructions exceed 500 lines`)

  const metadataPath = path.join(root, folderName, 'agents', 'openai.yaml')
  try {
    const metadata = await readFile(metadataPath, 'utf8')
    assert.match(
      metadata,
      /default_prompt:\s*["'].*\$[a-z0-9-]+/s,
      `${folderName}: default prompt must mention the skill`
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
}

const scriptFiles = await collectFiles(root)
const pythonFiles = scriptFiles.filter((file) => file.endsWith('.py'))
if (pythonFiles.length > 0) {
  const syntaxCheck = spawnSync(
    'python3',
    [
      '-c',
      'import ast,pathlib,sys; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8"), filename=p) for p in sys.argv[1:]]',
      ...pythonFiles
    ],
    { encoding: 'utf8' }
  )
  assert.equal(
    syntaxCheck.status,
    0,
    `bundled Python skill scripts must parse on the supported runtime:\n${syntaxCheck.stderr}`
  )
}

for (const script of scriptFiles.filter((file) => /\.(?:js|mjs)$/.test(file))) {
  const syntaxCheck = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  assert.equal(syntaxCheck.status, 0, `${script}: invalid JavaScript\n${syntaxCheck.stderr}`)
}

console.log(
  `Verified ${skillNames.length} bundled skill manifests and ${pythonFiles.length} Python scripts.`
)
