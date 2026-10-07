import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { authorizeDbWorkspace } from '../src/main/ipc/db-workspace-authorization.ts'
import { browserPartitionForWorkspace } from '../src/shared/browser-plugin.ts'

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
const media = await readFile('src/main/ipc/media-runtime-handlers.ts', 'utf8')
assert.match(media, /task\.workspaceId !== workspaceId/)
assert.match(media, /getRegisteredWindowWorkspace\(grant\.window\) !== grant\.workspaceId/)
assert.match(media, /authorizeDbWorkspace/)
console.log('workspace isolation verification passed')
