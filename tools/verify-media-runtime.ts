import assert from 'node:assert/strict'
import fs from 'node:fs'
const contract = fs.readFileSync('src/shared/media-runtime.ts', 'utf8')
const runtime = fs.readFileSync('src/main/ipc/media-runtime-handlers.ts', 'utf8')
const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
assert.match(contract, /MEDIA_CACHE_MAX_BYTES = 2 \* 1024 \* 1024 \* 1024/)
assert.match(runtime, /protocol\.handle\('ola-media'/)
assert.match(runtime, /seedanceEnabled: false, xaiEnabled: false/)
for (const lifecycle of ['task-create', 'task-cancel', 'task-delete', 'cache-cleanup'])
  assert.match(runtime, new RegExp(lifecycle))
assert.match(canvas, /addNode\('video'\)/)
console.log('Media runtime verification passed')
