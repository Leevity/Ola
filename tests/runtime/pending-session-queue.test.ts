import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

let repository: BusinessRepository | undefined
let root: string | undefined

afterEach(async () => {
  await repository?.close()
  if (root) await rm(root, { recursive: true, force: true })
  repository = undefined
  root = undefined
})

it('persists a session queue across repository restarts and scopes it by workspace', async () => {
  root = await mkdtemp(join(tmpdir(), 'ola-pending-session-queue-'))
  const path = join(root, 'data.db')
  repository = new BusinessRepository({ path, mode: 'direct' })
  const messages = [
    {
      id: 'queued-a',
      text: 'continue after restart',
      createdAt: 1,
      dispatchMode: 'interrupt_next'
    }
  ]

  await expect(
    repository.replacePendingSessionQueue('session-a', 'workspace-a', messages)
  ).resolves.toBe(true)
  await expect(repository.pendingSessionQueue('session-a', 'workspace-a')).resolves.toEqual(
    messages
  )
  await repository.close()
  repository = new BusinessRepository({ path, mode: 'direct' })

  await expect(repository.pendingSessionQueue('session-a', 'workspace-a')).resolves.toEqual(
    messages
  )
  await expect(repository.pendingSessionQueue('session-b', 'workspace-a')).resolves.toEqual([])
  await expect(repository.pendingSessionQueue('session-a', 'workspace-b')).resolves.toEqual([])
  await expect(
    repository.replacePendingSessionQueue(
      'session-a',
      'workspace-a',
      Array.from({ length: 52 }, (_, index) => ({ id: `queued-${index}` }))
    )
  ).rejects.toThrow('INVALID_BUSINESS_PENDING_SESSION_QUEUE')
})
