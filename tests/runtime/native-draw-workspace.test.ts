import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native draw history workspace boundary', () => {
  it('scopes listing, saving, deletion and clearing while rejecting cross-space ID replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-draw-workspace-'))
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
    const save = (id: string, workspaceId: string, prompt = id) =>
      client.request('db/draw-runs-save', {
        dbPath,
        id,
        workspaceId,
        prompt,
        providerName: 'Provider',
        modelName: 'Model',
        createdAt: 1000,
        updatedAt: 1000,
        isGenerating: false,
        imagesJson: '[]'
      })
    expect((await save('personal', 'local-personal')).success).toBe(true)
    expect((await save('team', 'team-a')).success).toBe(true)
    expect((await save('team', 'local-personal', 'spoof')).success).toBe(false)
    expect(
      (await client.request('db/draw-runs-list', { dbPath, workspaceId: 'team-a' })).map(
        (row: { id: string }) => row.id
      )
    ).toEqual(['team'])
    expect(
      (await client.request('db/draw-runs-list', { dbPath, workspaceId: 'local-personal' })).map(
        (row: { id: string }) => row.id
      )
    ).toEqual(['personal'])
    expect(
      (
        await client.request('db/draw-runs-delete', {
          dbPath,
          id: 'team',
          workspaceId: 'local-personal'
        })
      ).changed
    ).toBe(0)
    expect(
      (await client.request('db/draw-runs-clear', { dbPath, workspaceId: 'local-personal' }))
        .changed
    ).toBe(1)
    expect(await client.request('db/draw-runs-list', { dbPath, workspaceId: 'team-a' })).toEqual([
      expect.objectContaining({ id: 'team', prompt: 'team', workspace_id: 'team-a' })
    ])
  }, 30_000)

  it('assigns pre-workspace draw history to the local personal workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-draw-migration-'))
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
    expect(
      (
        await client.request('db/draw-runs-save', {
          dbPath,
          id: 'legacy',
          workspaceId: 'local-personal',
          prompt: 'Old drawing',
          providerName: 'Provider',
          modelName: 'Model',
          createdAt: 1000,
          updatedAt: 1000
        })
      ).success
    ).toBe(true)
    const database = new DatabaseSync(dbPath)
    try {
      database.exec(`
        DROP INDEX idx_draw_runs_workspace_created;
        ALTER TABLE draw_runs DROP COLUMN workspace_id;
      `)
    } finally {
      database.close()
    }
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(await client.request('db/draw-runs-list', { dbPath, workspaceId: 'team-a' })).toEqual([])
    expect(
      (await client.request('db/draw-runs-list', { dbPath, workspaceId: 'local-personal' })).map(
        (row: { id: string }) => row.id
      )
    ).toEqual(['legacy'])
  }, 30_000)
})
