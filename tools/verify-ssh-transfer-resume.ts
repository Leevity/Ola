import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { enrichTransferProgress } from '../src/renderer/src/stores/ssh/transfers'

const main = readFileSync('src/main/ipc/ssh-handlers.ts', 'utf8')
const store = readFileSync('src/renderer/src/stores/ssh-store.ts', 'utf8')

// SSH transfer resume is Main-owned now; this verifier must not depend on the
// retired C# implementation as its source of truth.
assert.equal((main.match(/args\.resume === true/g) || []).length, 3)
assert.doesNotMatch(main, /getNativeWorker|NativeSshTransferProgressEvent/)
assert.match(main, /function sftpAppendFile\(/)
assert.match(main, /function sftpReadRange\(/)
assert.match(main, /async function uploadLocalPath\([\s\S]*resume = false/)
assert.match(main, /async function downloadRemotePath\([\s\S]*resume = false/)
assert.match(main, /async function copyRemotePath\([\s\S]*resume = false/)
assert.match(main, /existing\.size > 0 && existing\.size < content\.byteLength/)
assert.match(main, /content\.subarray\(offset\)/)
assert.match(store, /request: \{ \.\.\.args, resume: true \}/)
assert.match(store, /retryTransfer: async[\s\S]*startTransfer\(\{ \.\.\.request, resume: true \}\)/)

const progress = enrichTransferProgress(
  {
    taskId: 'task',
    type: 'download',
    stage: 'transferring',
    updatedAt: 1_000,
    progress: { currentBytes: 100, totalBytes: 1_000 }
  },
  { currentBytes: 300, totalBytes: 1_000 },
  2_000
)
assert.equal(progress?.speedBytesPerSecond, 200)
assert.equal(progress?.remainingSeconds, 3.5)
assert.match(store, /pauseTransfer: async/)
assert.match(store, /retryCount: \(previous\.retryCount \?\? 0\) \+ 1/)
console.log('SSH transfer resume verification passed')
