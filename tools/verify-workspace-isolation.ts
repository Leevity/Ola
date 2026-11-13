import assert from 'node:assert/strict'
import { authorizeDbWorkspace } from '../src/main/ipc/db-workspace-authorization.ts'
import { browserPartitionForWorkspace } from '../src/shared/browser-plugin.ts'
import { readCollapsedSource } from './lib/source-text.ts'

const available = async (): Promise<ReadonlySet<string>> => new Set(['team-a'])
assert.equal(
  await authorizeDbWorkspace('local-personal', available, 'local-personal'),
  'local-personal'
)
assert.equal(await authorizeDbWorkspace('team-a', available, 'team-a'), 'team-a')
await assert.rejects(authorizeDbWorkspace('team-b', available, 'team-b'), /unavailable/)
await assert.rejects(authorizeDbWorkspace('team-a', available, 'local-personal'), /window-mismatch/)
assert.notEqual(
  browserPartitionForWorkspace('team-a'),
  browserPartitionForWorkspace('local-personal')
)
assert.notEqual(browserPartitionForWorkspace('team-a'), browserPartitionForWorkspace('team-b'))
// These are isolation invariants, not layout: the same tokens must be present, so the
// source is read collapsed and each pattern tolerates a break the formatter may insert
// around `.` and the comparison operator. Nothing here is relaxed.
const media = await readCollapsedSource('src/main/ipc/media-runtime-handlers.ts')
// The cross-workspace task guard lives in two handlers. Bound each by its own
// registration: an unbounded match lets a self-compare or flipped operator at one
// site stay green because the other site still matches.
const mediaRegistrations = [...media.matchAll(/registerMessagePackHandler/g)].map(
  (match) => match.index as number
)
const mediaHandler = (channel: string): string => {
  const start = media.indexOf(`'${channel}'`)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = mediaRegistrations.filter((index) => index <= start).at(-1)
  const next = mediaRegistrations.find((index) => index > start)
  return media.slice(owner ?? start, next ?? media.length)
}
const taskWorkspaceGuard = /task\s*\.\s*workspaceId\s*!==\s*workspaceId/
assert.match(
  mediaHandler('media:task-cancel'),
  taskWorkspaceGuard,
  'media:task-cancel must reject tasks owned by another workspace'
)
assert.match(
  mediaHandler('media:task-delete'),
  taskWorkspaceGuard,
  'media:task-delete must reject tasks owned by another workspace'
)
// The preview grant is re-checked at two sites in the ola-media protocol handler.
// Anchor each uniquely (the !grant guard, then the post-readFile re-check) so flipping
// one !== to === cannot hide behind the other.
assert.match(
  media,
  /!grant\s*\|\|\s*getRegisteredWindowWorkspace\(\s*grant\s*\.\s*window\s*\)\s*!==\s*grant\s*\.\s*workspaceId/,
  'ola-media must reject a preview grant whose window workspace changed'
)
assert.match(
  media,
  /fs\s*\.\s*readFile\(\s*filePath\s*\)[\s\S]*?getRegisteredWindowWorkspace\(\s*grant\s*\.\s*window\s*\)\s*!==\s*grant\s*\.\s*workspaceId[\s\S]*?return\s+new\s+Response\(\s*data/,
  'ola-media must re-check the grant workspace after reading the file'
)
// The import alone satisfies a bare token check. Assert all five call sites with their
// real arguments; the two identical workspaceId calls are counted so removing either
// turns the gate red.
assert.match(
  media,
  /authorizeDbWorkspace\(\s*id,\s*loadOfflineWorkspaceIds,\s*id\s*\)/,
  'workspace() must authorize the resolved workspace id'
)
assert.match(
  media,
  /authorizeDbWorkspace\(\s*task\s*\.\s*workspaceId,\s*loadOfflineWorkspaceIds\s*\)/,
  'pollTask must authorize the task workspace'
)
// Count with a whitespace-tolerant regex: a narrow re-wrap spaces the argument list, so
// a literal needle would be layout-coupled and miss the wrapped form.
assert.equal(
  media.match(/authorizeDbWorkspace\(\s*workspaceId,\s*loadOfflineWorkspaceIds\s*\)/g)?.length ?? 0,
  2,
  'capabilities and task-create must each authorize the workspace'
)
assert.match(
  media,
  /authorizeDbWorkspace\(\s*grant\s*\.\s*workspaceId,\s*loadOfflineWorkspaceIds,\s*grant\s*\.\s*workspaceId\s*\)/,
  'ola-media must authorize the grant workspace'
)
console.log('workspace isolation verification passed')
