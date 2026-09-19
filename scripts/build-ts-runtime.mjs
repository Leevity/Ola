import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'

await mkdir('out/runtime', { recursive: true })
await build({
  entryPoints: ['src/runtime/host/cli.ts'],
  outfile: 'out/runtime/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true
})
await copyFile('src/runtime/storage/journal-worker.mjs', 'out/runtime/journal-worker.mjs')
await copyFile('src/runtime/storage/journal-schema.mjs', 'out/runtime/journal-schema.mjs')
await copyFile('src/runtime/storage/legacy-read-worker.mjs', 'out/runtime/legacy-read-worker.mjs')
await copyFile('src/runtime/storage/business-worker.mjs', 'out/runtime/business-worker.mjs')
await copyFile('src/runtime/storage/business-schema.mjs', 'out/runtime/business-schema.mjs')

// Electron Main also constructs RunJournal directly. The Worker URL is kept
// dynamic by design, so Rollup cannot discover this sibling asset.
await copyFile('src/runtime/storage/journal-worker.mjs', 'out/main/journal-worker.mjs')
await copyFile('src/runtime/storage/journal-schema.mjs', 'out/main/journal-schema.mjs')
await copyFile('src/runtime/storage/legacy-read-worker.mjs', 'out/main/legacy-read-worker.mjs')
await copyFile('src/runtime/storage/business-worker.mjs', 'out/main/business-worker.mjs')
await copyFile('src/runtime/storage/business-schema.mjs', 'out/main/business-schema.mjs')

// The Electron Main bundle keeps this Worker as a runtime URL so it cannot be
// inlined by Rollup. Keep it beside out/main/index.js for the TS CodeGraph mode.
await copyFile('src/runtime/codegraph/graph-store-worker.mjs', 'out/main/graph-store-worker.mjs')

await mkdir('out/storage', { recursive: true })
await copyFile('src/runtime/storage/lease-worker.mjs', 'out/storage/lease-worker.mjs')
