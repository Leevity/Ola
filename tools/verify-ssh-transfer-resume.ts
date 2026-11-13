import assert from 'node:assert/strict'
import { enrichTransferProgress } from '../src/renderer/src/stores/ssh/transfers'
import { assertMatch, collapseWhitespace, readSource } from './lib/source-text.ts'

// Token-level assertions read collapsed sources so a Biome re-wrap cannot turn this gate red.
// Function bodies are located on the raw text (declaration anchors are line-based) and then
// collapsed, so each `resume = false` is proved inside its own function. The token occurs at
// six sites in this file; an unbounded window ran from uploadLocalPath's signature to the last
// site in copyRemotePath, so destroying both of uploadLocalPath's own defaults stayed green.
const mainRaw = await readSource('src/main/ipc/ssh-handlers.ts')
const main = collapseWhitespace(mainRaw)
const store = collapseWhitespace(await readSource('src/renderer/src/stores/ssh-store.ts'))

const declarations = [
  ...mainRaw.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)
]
const functionBody = (name: string): string => {
  const owner = declarations.find((entry) => entry[1] === name)
  if (!owner) throw new Error(`Missing function ${name}`)
  const next = declarations.find((entry) => (entry.index as number) > (owner.index as number))
  return collapseWhitespace(mainRaw.slice(owner.index, next?.index ?? mainRaw.length))
}

// SSH transfer resume is Main-owned now; this verifier must not depend on the
// retired C# implementation as its source of truth.
assert.equal(
  (main.match(/args\s*\.\s*resume\s*===\s*true/g) ?? []).length,
  3,
  'ssh-handlers resume branches'
)
assert.doesNotMatch(main, /getNativeWorker|NativeSshTransferProgressEvent/)
assertMatch(main, /function\s+sftpAppendFile\s*\(/, 'sftpAppendFile')
assertMatch(main, /function\s+sftpReadRange\s*\(/, 'sftpReadRange')
assertMatch(functionBody('uploadLocalPath'), /resume\s*=\s*false/, 'uploadLocalPath resume')
assertMatch(functionBody('downloadRemotePath'), /resume\s*=\s*false/, 'downloadRemotePath resume')
assertMatch(functionBody('copyRemotePath'), /resume\s*=\s*false/, 'copyRemotePath resume')
assertMatch(
  main,
  /existing\s*\.\s*size\s*>\s*0\s*&&\s*existing\s*\.\s*size\s*<\s*content\s*\.\s*byteLength/,
  'partial-file resume guard'
)
assertMatch(main, /content\s*\.\s*subarray\(\s*offset\s*\)/, 'resume offset slice')
assertMatch(store, /request:\s*\{\s*\.\.\.args,\s*resume:\s*true\s*\}/, 'transfer request shape')
// Both anchors are unique in the store, so this span is pinned and cannot borrow a neighbour.
assertMatch(
  store,
  /retryTransfer:\s*async[\s\S]*startTransfer\(\s*\{\s*\.\.\.request,\s*resume:\s*true\s*\}\s*\)/,
  'retryTransfer resumes'
)

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
assertMatch(store, /pauseTransfer:\s*async/, 'pauseTransfer')
assertMatch(
  store,
  /retryCount:\s*\(\s*previous\s*\.\s*retryCount\s*\?\?\s*0\s*\)\s*\+\s*1/,
  'retryCount increments'
)
console.log('SSH transfer resume verification passed')
