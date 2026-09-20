import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamRuntimeStore } from '../../src/main/teams/team-runtime-store'

describe('TeamRuntimeStore', () => {
  it('preserves the team manifest and migrates legacy messages to jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-team-runtime-'))
    const store = new TeamRuntimeStore(root)
    try {
      const created = await store.create({
        teamName: ' Team / One ',
        description: 'description',
        sessionId: 'session-1',
        workingFolder: '/workspace'
      })
      expect(created.teamName).toBe('Team-One')
      await writeFile(
        join(created.runtimePath, 'messages.json'),
        JSON.stringify([
          { id: 'old', from: 'lead', to: 'all', type: 'broadcast', content: 'legacy', timestamp: 1 }
        ]),
        'utf8'
      )
      await rm(join(created.runtimePath, 'messages.jsonl'))
      await store.appendMessage({
        teamName: created.teamName,
        message: {
          id: 'new',
          from: 'lead',
          to: 'worker',
          type: 'message',
          content: 'new',
          timestamp: 2
        }
      })
      await expect(
        store.consumeMessages({ teamName: created.teamName, recipient: 'worker' })
      ).resolves.toEqual([
        { id: 'old', from: 'lead', to: 'all', type: 'broadcast', content: 'legacy', timestamp: 1 },
        { id: 'new', from: 'lead', to: 'worker', type: 'message', content: 'new', timestamp: 2 }
      ])
      await store.updateMember({
        teamName: created.teamName,
        memberId: 'worker',
        patch: { name: 'Worker', status: 'working' }
      })
      const snapshot = await store.snapshot({ teamName: created.teamName })
      expect(snapshot?.team.members).toContainEqual(
        expect.objectContaining({ agentId: 'worker', name: 'Worker' })
      )
      expect(JSON.parse(await readFile(join(created.runtimePath, 'team.json'), 'utf8')).name).toBe(
        'Team-One'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates identical team names by workspace scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-team-runtime-scope-'))
    const store = new TeamRuntimeStore(root)
    try {
      await store.create({
        teamName: 'same-name',
        description: 'personal',
        workspaceId: 'personal'
      })
      await store.create({ teamName: 'same-name', description: 'team', workspaceId: 'team-a' })
      await store.appendMessage({
        teamName: 'same-name',
        workspaceId: 'personal',
        message: {
          id: 'personal-message',
          from: 'lead',
          to: 'all',
          type: 'broadcast',
          content: 'personal-only',
          timestamp: 1
        }
      })
      await expect(
        store.snapshot({ teamName: 'same-name', workspaceId: 'team-a' })
      ).resolves.toMatchObject({ team: { description: 'team' }, recentMessages: [] })
      await expect(
        store.snapshot({ teamName: 'same-name', workspaceId: 'personal' })
      ).resolves.toMatchObject({
        team: { description: 'personal' },
        recentMessages: [{ id: 'personal-message' }]
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent manifest mutations without losing tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-team-runtime-lock-'))
    const store = new TeamRuntimeStore(root)
    try {
      await store.create({ teamName: 'parallel', description: 'parallel tasks' })
      await Promise.all(
        ['task-a', 'task-b'].map((id) =>
          store.mutateManifest({
            teamName: 'parallel',
            mutate: (manifest) => {
              manifest.tasks.push({
                id,
                subject: id,
                description: id,
                status: 'pending',
                owner: null,
                dependsOn: []
              })
            }
          })
        )
      )
      const snapshot = await store.snapshot({ teamName: 'parallel' })
      expect(snapshot?.team.tasks.map((task) => task.id).sort()).toEqual(['task-a', 'task-b'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
