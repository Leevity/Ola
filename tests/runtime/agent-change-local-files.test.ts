import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildFileSnapshot,
  readLocalTextMatchingHash,
  rollbackLocalFileChange,
  type TrackedFileChange
} from '../../src/main/ipc/agent-change-handlers'

function change(filePath: string, op: 'create' | 'modify', beforeText?: string): TrackedFileChange {
  return {
    id: 'run:1',
    runId: 'run',
    filePath,
    transport: 'local',
    op,
    status: 'open',
    before: buildFileSnapshot(op === 'modify', beforeText),
    after: buildFileSnapshot(true, 'after'),
    createdAt: Date.now()
  }
}

describe('local agent file changes', () => {
  it('uses the recorded hash for current-content hydration and restores local files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-agent-change-'))
    const existing = join(root, 'existing.txt')
    const created = join(root, 'created.txt')
    try {
      await writeFile(existing, 'after', 'utf8')
      const modify = change(existing, 'modify', 'before')
      await expect(readLocalTextMatchingHash(existing, modify.after.hash)).resolves.toBe('after')
      await expect(rollbackLocalFileChange(modify)).resolves.toEqual({ reverted: true })
      await expect(readFile(existing, 'utf8')).resolves.toBe('before')

      await writeFile(created, 'after', 'utf8')
      const create = change(created, 'create')
      await expect(rollbackLocalFileChange(create)).resolves.toEqual({ reverted: true })
      await expect(readFile(created, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
