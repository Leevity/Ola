import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// These assertions are about the skipped-run contract, not about layout. Reading with
// whitespace collapsed lets Biome re-wrap unions, argument lists and JSX attributes
// without turning the gate red. A narrow width also renders a union with a leading
// `|`, which is the same member list, so that bar is optional in the patterns.
const scheduler = await readCollapsedSource('src/main/cron/cron-scheduler.ts')
const handlers = await readCollapsedSource('src/main/ipc/cron-handlers.ts')
const dao = await readCollapsedSource('src/main/db/cron-dao.ts')
const store = await readCollapsedSource('src/renderer/src/stores/cron-store.ts')
const cronPanel = await readCollapsedSource('src/renderer/src/components/cowork/CronPanel.tsx')
const tasksPage = await readCollapsedSource('src/renderer/src/components/tasks/TasksPage.tsx')
const app = await readCollapsedSource('src/renderer/src/App.tsx')
const cronEvents = await readCollapsedSource('src/renderer/src/lib/tools/cron-events.ts')
const workspaceEvents = await readCollapsedSource('src/main/cron/cron-workspace-events.ts')

const runStatusUnion = String.raw`\|?\s*'running'\s*\|\s*'success'\s*\|\s*'error'\s*\|\s*'aborted'\s*\|\s*'skipped'`
const finishedStatusUnion = String.raw`\|?\s*'success'\s*\|\s*'error'\s*\|\s*'aborted'\s*\|\s*'skipped'`

assert.match(dao, new RegExp(String.raw`CronRunStatus =\s*${runStatusUnion}`))
assert.match(store, new RegExp(String.raw`status:\s*${runStatusUnion}`))
assert.match(scheduler, /export async function recordSkippedCronRun\(/)
assert.match(scheduler, /startedAt:\s*scheduledFor/)
assert.match(scheduler, /scheduledFor,/)
assert.match(scheduler, /jobNameSnapshot:\s*job\s*\.\s*name/)
assert.match(scheduler, /deliveryTargetSnapshot:\s*job\s*\.\s*delivery_target/)
assert.match(scheduler, /finishedAt:\s*Date\s*\.\s*now\(\s*\)/)
// `status: 'skipped'` occurs twice: the persisted patch and the run-finished payload.
// A file-global check stayed green when only the persisted status drifted, so each call
// is bound to its own first `status:` token.
assert.match(
  scheduler,
  /updateCronRun\(\s*\{(?:(?!status:)[\s\S])*status:\s*'skipped'/,
  'persisted skipped run must record status skipped'
)
assert.match(
  scheduler,
  /'cron:run-finished',\s*\{(?:(?!status:)[\s\S])*status:\s*'skipped'/,
  'cron:run-finished payload must report status skipped'
)
assert.match(scheduler, /error:\s*reason/)
assert.match(
  scheduler,
  /sendCronWorkspaceEvent\(\s*job\s*\.\s*workspace_id \?\? 'local-personal',\s*'cron:run-finished'/
)
assert.match(
  workspaceEvents,
  /safeSendMessagePackToWorkspaceWindows\(\s*workspaceId,\s*channel,\s*\{\s*\.\.\.payload,\s*workspaceId\s*\}\s*\)/
)
assert.match(scheduler, /await recordSkippedCronRun\(\s*job,\s*firedAt\s*\)/)
assert.match(handlers, /await recordSkippedCronRun\(\s*row,\s*firedAt\s*\)/)
assert.match(handlers, new RegExp(String.raw`status:\s*${runStatusUnion}`))
assert.match(app, new RegExp(String.raw`status:\s*${finishedStatusUnion}`))
assert.match(cronEvents, new RegExp(String.raw`status:\s*${finishedStatusUnion}`))
assert.match(cronPanel, /run\s*\.\s*status === 'skipped'/)
assert.match(tasksPage, /\|\s*'skipped'/)
assert.match(tasksPage, /<option\s+value="skipped"\s*>/)

console.log('cron skipped runs verification passed')
