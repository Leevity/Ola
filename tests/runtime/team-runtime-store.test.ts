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
})
