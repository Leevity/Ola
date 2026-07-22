/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, startWorker } from './verify-message-windowing.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')

function historyItem(sessionId, index, status = 'completed') {
  const startedAt = 1_700_000_000_000 + index
  const toolUseId = `tool-${index}`
  return {
    id: `history-${sessionId}-${index}`,
    sessionId,
    subAgentId: toolUseId,
    toolUseId,
    name: `worker-${index}`,
    status,
    startedAt,
    completedAt: status === 'running' ? null : startedAt + 10,
    updatedAt: startedAt + 10,
    sortOrder: index,
    snapshotJson: JSON.stringify({ toolUseId, sessionId, status, report: `result-${index}` })
  }
}

async function createSession(client, dbPath, id) {
  const result = await client.request('db/sessions-create', { dbPath, id, title: id })
  assert(result.success, `failed to create session ${id}: ${JSON.stringify(result)}`)
}

async function verifySourceInvariants() {
  const persistence = await readFile(
    path.join(repoRoot, 'src/renderer/src/stores/sub-agent-history-persist.ts'),
    'utf8'
  )
  const runtime = await readFile(
    path.join(
      repoRoot,
      'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeSubAgentExecutor.cs'
    ),
    'utf8'
  )
  assert(
    persistence.includes('`${item.sessionId}:${item.toolUseId}`'),
    'apply queue is not isolated by session and tool-use ID'
  )
  assert(
    persistence.includes('IPC.SUB_AGENT_HISTORY_LIST'),
    'renderer restore does not use the snapshot-bearing paginated list route'
  )
  const replacePosition = persistence.indexOf('IPC.SUB_AGENT_HISTORY_REPLACE')
  const markPosition = persistence.indexOf('IPC.SUB_AGENT_HISTORY_MIGRATION_MARK')
  assert(
    replacePosition > 0 && markPosition > replacePosition,
    'migration mark precedes replacement'
  )
  assert(
    runtime.includes('collector.SetCancelled();') &&
      runtime.includes('writer.WriteBoolean("cancelled", Cancelled);'),
    'sub-agent cancellation is not represented explicitly in the terminal event'
  )
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ola-subagent-history-'))
  const dbPath = path.join(tempDir, 'history.db')
  let client
  let child
  try {
    ;({ client, child } = await startWorker(tempDir))
    const initialized = await client.request('db/initialize', { dbPath })
    assert(initialized.success, `database initialization failed: ${JSON.stringify(initialized)}`)
    await Promise.all([
      createSession(client, dbPath, 'session-a'),
      createSession(client, dbPath, 'session-b')
    ])

    const sessionA = Array.from({ length: 260 }, (_, index) => historyItem('session-a', index))
    const sessionB = [historyItem('session-b', 0, 'cancelled')]
    const [replaceA, replaceB] = await Promise.all([
      client.request('db/sub-agent-history-replace', {
        dbPath,
        sessionId: 'session-a',
        items: sessionA
      }),
      client.request('db/sub-agent-history-replace', {
        dbPath,
        sessionId: 'session-b',
        items: sessionB
      })
    ])
    assert(replaceA.success && replaceB.success, 'concurrent session replacement failed')

    const page = await client.request('db/sub-agent-history-list', {
      dbPath,
      sessionId: 'session-a',
      limit: 50,
      offset: 0
    })
    assert(page.items.length === 50 && page.hasMore, 'history pagination contract failed')
    assert(
      page.items.every((row) => row.snapshotJson),
      'detail page omitted snapshots'
    )
    const nextPage = await client.request('db/sub-agent-history-list', {
      dbPath,
      sessionId: 'session-a',
      limit: 50,
      offset: 50
    })
    assert(nextPage.items.length === 50, 'second history page failed')
    assert(
      new Set([...page.items, ...nextPage.items].map((row) => row.toolUseId)).size === 100,
      'history pages overlap'
    )

    const index = await client.request('db/sub-agent-history-index', {
      dbPath,
      sessionId: 'session-a',
      limit: 500
    })
    assert(index.length === 260, 'large history index was truncated unexpectedly')
    assert(
      index.every((row) => row.snapshotJson == null),
      'lightweight index leaked snapshots'
    )

    const failedMigration = await client.request('db/sub-agent-history-replace', {
      dbPath,
      sessionId: 'session-a',
      items: [historyItem('wrong-session', 1)]
    })
    assert(!failedMigration.success, 'invalid migration replacement unexpectedly succeeded')
    const beforeMark = await client.request('db/sub-agent-history-migration-status', {
      dbPath,
      key: 'verification-migration'
    })
    assert(!beforeMark.applied, 'failed migration was marked as applied')
    const firstMark = await client.request('db/sub-agent-history-migration-mark', {
      dbPath,
      key: 'verification-migration'
    })
    const secondMark = await client.request('db/sub-agent-history-migration-mark', {
      dbPath,
      key: 'verification-migration'
    })
    assert(firstMark.success && secondMark.success, 'migration mark is not idempotent')

    await verifySourceInvariants()
    console.log('sub-agent history verification passed')
  } finally {
    client?.close()
    if (child && child.exitCode === null) child.kill()
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
