import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunJournal } from '../../src/runtime/storage/run-journal'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
})

describe('durable artifact index removal', () => {
  it('hides only the selected event and leaves the file and journal history intact after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-artifact-hide-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const filePath = join(directory, 'report.md')
    const databasePath = join(directory, 'runs.db')
    await writeFile(filePath, '# retained\n')

    const journal = new RunJournal(databasePath)
    cleanup.push(() => journal.close())
    await journal.create({
      runId: 'artifact-run',
      taskId: 'task',
      requestId: 'request',
      traceId: 'trace',
      sessionId: 'session',
      workspaceId: 'local-personal',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'local', modelId: 'model' },
      prompt: 'Create result',
      unattended: false
    })
    const event = await journal.append('artifact-run', 'local-personal', 'artifact.registered', {
      toolCallId: 'write-1',
      kind: 'file',
      path: filePath,
      operation: 'create'
    })
    await journal.transition('artifact-run', 'local-personal', ['queued'], 'completed')
    expect(await journal.artifacts('local-personal')).toHaveLength(1)
    await expect(
      journal.hideArtifact('other-workspace', 'artifact-run', event.seq)
    ).rejects.toThrow('ARTIFACT_NOT_FOUND')
    await expect(journal.hideArtifact('local-personal', 'artifact-run', 1)).rejects.toThrow(
      'ARTIFACT_NOT_FOUND'
    )
    expect(await journal.hideArtifact('local-personal', 'artifact-run', event.seq)).toEqual({
      hidden: true
    })
    expect(await journal.hideArtifact('local-personal', 'artifact-run', event.seq)).toEqual({
      hidden: true
    })
    expect(await journal.artifacts('local-personal')).toEqual([])
    expect(
      (await journal.snapshot('artifact-run', 'local-personal'))?.events.some(
        (item) => item.seq === event.seq && item.type === 'artifact.registered'
      )
    ).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('# retained\n')
    await journal.close()

    const reopened = new RunJournal(databasePath)
    cleanup.push(() => reopened.close())
    expect(await reopened.artifacts('local-personal')).toEqual([])
    expect(await readFile(filePath, 'utf8')).toBe('# retained\n')
  })
})
