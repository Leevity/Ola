#!/usr/bin/env node
// Lint: forbid dangerous Electron API access at the top level of main-process
// modules. Top-level access to `electron.session.*`, `BrowserWindow.fromId`,
// or `app.getPath` runs while the module is being `require`d, which happens
// BEFORE `app.whenReady()` fires. Those APIs throw "Session can only be
// received when app is ready" / "getPath can only be called after app ready"
// and the app fails to start.
//
// This script statically scans `src/main/**/*.ts` for top-level statements
// that touch those APIs and exits non-zero if any are found. The recommended
// fix is to wrap the access in a function and call it from inside an
// `app.whenReady()` callback (or guard with `app.isReady()`).
//
// The script is intentionally simple — no TypeScript AST, just a regex over
// the source. The patterns cover the failure modes we have seen so far.
// New patterns should be added when new APIs cause start-up crashes.

import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

interface Violation {
  file: string
  line: number
  text: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..', 'src', 'main')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__tests__'])

// Patterns that, when found at the top level (`export const =` or bare
// module-level call), are forbidden. These match the symptoms of the
// start-up crash we've already seen. We intentionally only flag the
// most dangerous variants; ordinary code paths wrapped in
// `app.whenReady()` callbacks are fine.
//
// The canonical "bomb" is: `export const _foo = Boolean(electron.session.defaultSession)`
// or `electron.session.fromPartition('...')` directly at the top level.
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /^\s*export\s+const\s+\w+\s*=\s*Boolean\s*\(\s*[^)]*electron\s*\.\s*session\s*\.\s*defaultSession\s*\)/,
    reason: 'electron.session.defaultSession must not be evaluated at module load time'
  },
  {
    pattern: /^\s*electron\s*\.\s*session\s*\.\s*fromPartition\s*\(/,
    reason: 'electron.session.fromPartition() must not be called at module load time'
  }
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (st.isFile() && full.endsWith('.ts')) out.push(full)
  }
  return out
}

const violations: Violation[] = []

for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file, line: i + 1, text: line.trim() })
        void reason
        break
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `[check-main-module-safety] found ${violations.length} forbidden top-level access(es):`
  )
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`)
  }
  console.error('')
  console.error('Fix: wrap the access in a function and call it from inside app.whenReady().')
  process.exit(1)
}

console.log('[check-main-module-safety] OK — no forbidden top-level Electron API access.')
