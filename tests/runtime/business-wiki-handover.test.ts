import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import { wikiWorkspaceStorageKey } from '../../src/main/wiki/wiki-workspace-key'
import type { ProjectWikiDocument } from '../../src/shared/project-wiki'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('continues Native Wiki documents on a TS handover copy without crossing workspaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-ts-wiki-handover-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  const dbPath = join(directory, 'native.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  const projectRoot = '/projects/shared'
  const local: ProjectWikiDocument = {
    id: 'local-wiki',
    projectRoot,
    generatedAt: 1,
    fileCount: 1,
    nodes: [{ path: 'local.ts', kind: 'file', size: 1, modifiedAt: 1 }]
  }
  const team: ProjectWikiDocument = {
    id: 'team-wiki',
    projectRoot,
    generatedAt: 2,
    fileCount: 1,
    nodes: [{ path: 'team.ts', kind: 'file', size: 2, modifiedAt: 2 }]
  }
  for (const [workspaceId, document] of [
    ['local-personal', local],
    ['team-a', team]
  ] as const) {
    expect(
      (
        await client.request('db/wiki-save', {
          dbPath,
          projectRoot: wikiWorkspaceStorageKey(projectRoot, workspaceId),
          documentJson: JSON.stringify(document),
          generatedAt: document.generatedAt
        })
      ).success
    ).toBe(true)
  }
  const liveReader = new LegacyReadRepository(dbPath)
  cleanup.push(() => liveReader.close())
  await expect(liveReader.wikiDocument(projectRoot, 'local-personal')).resolves.toEqual(local)
  await expect(liveReader.wikiDocument(projectRoot, 'team-a')).resolves.toEqual(team)
  await expect(liveReader.wikiDocument(projectRoot, 'team-b')).resolves.toBeNull()
  await expect(
    liveReader.wikiDocument(wikiWorkspaceStorageKey(projectRoot, 'team-a'), 'local-personal')
  ).rejects.toThrow('INVALID_LEGACY_WIKI_PROJECT_ROOT')
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())

  await expect(repository.wikiDocument(projectRoot, 'local-personal')).resolves.toEqual(local)
  await expect(repository.wikiDocument(projectRoot, 'team-a')).resolves.toEqual(team)
  await expect(repository.wikiDocument(projectRoot, 'team-b')).resolves.toBeNull()
  await expect(
    repository.wikiDocument(wikiWorkspaceStorageKey(projectRoot, 'team-a'), 'local-personal')
  ).rejects.toThrow('INVALID_BUSINESS_WIKI_PROJECT_ROOT')

  const updatedTeam: ProjectWikiDocument = {
    ...team,
    generatedAt: 3,
    nodes: [{ path: 'new-team.ts', kind: 'file', size: 3, modifiedAt: 3, hash: 'hash-a' }]
  }
  await expect(repository.saveWikiDocument(updatedTeam, 'team-a', 4)).resolves.toBe(true)
  await expect(repository.wikiDocument(projectRoot, 'team-a')).resolves.toEqual(updatedTeam)
  await expect(repository.wikiDocument(projectRoot, 'local-personal')).resolves.toEqual(local)
  const copy = new DatabaseSync(snapshot.backupPath)
  const teamKey = wikiWorkspaceStorageKey(projectRoot, 'team-a')
  expect(
    copy.prepare('SELECT node_path FROM wiki_nodes WHERE project_root=?').all(teamKey)
  ).toEqual([{ node_path: 'new-team.ts' }])
  expect(
    copy.prepare('SELECT file_path FROM wiki_file_snapshots WHERE project_root=?').all(teamKey)
  ).toEqual([{ file_path: 'new-team.ts' }])
  expect(
    copy
      .prepare('SELECT count(*) AS count FROM wiki_generation_runs WHERE project_root=?')
      .get(teamKey)
  ).toEqual({ count: 2 })
  copy.close()

  await expect(repository.deleteWikiDocument(projectRoot, 'team-a')).resolves.toBe(true)
  await expect(repository.wikiDocument(projectRoot, 'team-a')).resolves.toBeNull()
  await expect(repository.wikiDocument(projectRoot, 'local-personal')).resolves.toEqual(local)
})
