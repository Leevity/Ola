import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { enrichTransferProgress } from '../src/renderer/src/stores/ssh/transfers'

const main = readFileSync('src/main/ipc/ssh-handlers.ts', 'utf8')
const store = readFileSync('src/renderer/src/stores/ssh-store.ts', 'utf8')
const stream = readFileSync('sidecars/Ola.Native.Worker/Modules/Ssh/SshOpenSsh.cs', 'utf8')
const upload = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/Ssh/SshTransferUploadTools.cs',
  'utf8'
)
const download = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/Ssh/SshTransferDownloadTools.cs',
  'utf8'
)
const remoteCopy = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/Ssh/SshTransferRemoteCopyTools.cs',
  'utf8'
)

assert.equal((main.match(/resume: args\.resume === true/g) || []).length, 3)
assert.match(store, /request: \{ \.\.\.args, resume: true \}/)
assert.match(store, /retryTransfer: async[\s\S]*startTransfer\(\{ \.\.\.request, resume: true \}\)/)
assert.match(stream, /input\.Seek\(written, SeekOrigin\.Begin\)/)
assert.match(stream, /CopyPrefixAsync\(existing, output, existingPrefixBytes/)
assert.match(stream, /BuildAtomicWriteCommand\(string remotePath\)/)
assert.match(stream, /os\.fsync\(output\.fileno\(\)\)/)
assert.match(stream, /os\.chmod\(temporary, mode\)/)
assert.match(stream, /os\.replace\(temporary, target\)/)
assert.match(stream, /resumeOffset > 0[\s\S]*cat >>/)
assert.match(upload, /existingTarget\.Size > 0 && existingTarget\.Size < node\.Size/)
assert.match(upload, /sourceOffset: resumeOffset/)
assert.match(upload, /: SshOpenSsh\.BuildAtomicWriteCommand\(remotePath\)/)
assert.match(download, /tail -c \+\{resumeOffset \+ 1\}/)
assert.match(download, /existingPrefixBytes: resumeOffset/)
assert.match(download, /AvailableFreeSpace/)
assert.match(remoteCopy, /resumeOffset: resumeOffset/)
assert.match(upload, /EnsureRemoteDiskSpaceAsync/)
assert.match(remoteCopy, /EnsureTargetDiskSpaceAsync/)
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
