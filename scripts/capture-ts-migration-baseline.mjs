import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const output = new URL('../docs/migrations/ts-runtime/worktree-baseline.json', import.meta.url)
const root = new URL('../', import.meta.url)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const entries = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
  cwd: root,
  encoding: 'buffer',
  maxBuffer: 64 * 1024 * 1024
})
  .toString('utf8')
  .split('\0')
  .filter(
    (entry) =>
      entry &&
      !entry.endsWith(' scripts/capture-ts-migration-baseline.mjs') &&
      !entry.endsWith(' docs/migrations/ts-runtime/worktree-baseline.json')
  )

const files = []
for (const entry of entries) {
  const status = entry.slice(0, 2)
  const pathname = entry.slice(3)
  const generated =
    /^(?:dist-staged-(?:mac|linux|win)\/|out\/|node_modules\/)/.test(pathname) ||
    pathname.endsWith('.tsbuildinfo')
  let size = null
  let sha256 = null
  try {
    const file = new URL(pathname, root)
    const metadata = await stat(file)
    if (metadata.isFile()) {
      size = metadata.size
      if (!generated)
        sha256 = createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  files.push({ status, path: pathname, generated, size, sha256 })
}

const baseline = {
  schemaVersion: 1,
  head,
  capturedAt: new Date().toISOString(),
  notes:
    'Read-only worktree snapshot before supplemental migration edits. Build artifacts keep path and size, not content hashes. This file itself is excluded.',
  files
}
await writeFile(output, JSON.stringify(baseline, null, 2) + '\n')
console.log(`Captured ${files.length} pre-existing worktree entries at ${head}`)
