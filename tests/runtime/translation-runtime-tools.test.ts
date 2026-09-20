import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranslationRuntimeTools } from '../../src/main/runtime/translation-runtime-tools'

const run = (fileRoot?: string) => ({
  runId: 'translation-run',
  taskId: 'translation-task',
  requestId: 'translation-request',
  traceId: 'translation-trace',
  sessionId: 'translation-session',
  workspaceId: 'local-personal',
  environmentId: 'local',
  prompt: 'translate',
  unattended: false,
  modelSource: { kind: 'local' as const, providerId: 'provider', modelId: 'model' },
  translationContext: {
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    ...(fileRoot ? { fileRoot } : {})
  }
})

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('TS translation runtime tools', () => {
  it('keeps Write/Edit/Read in an ephemeral per-run buffer', async () => {
    const tools = Object.fromEntries(
      createTranslationRuntimeTools().map((tool) => [tool.name, tool])
    )
    const context = { run: run(), signal: new AbortController().signal }
    expect(
      await tools.Write.execute(tools.Write.validate({ content: 'Hello world' }), context)
    ).toEqual({
      __olaTranslationBufferUpdate: true,
      content: 'Hello world'
    })
    expect(
      await tools.Edit.execute(
        tools.Edit.validate({ old_string: 'world', new_string: 'Ola' }),
        context
      )
    ).toEqual({
      __olaTranslationBufferUpdate: true,
      content: 'Hello Ola'
    })
    expect(await tools.Read.execute(tools.Read.validate({}), context)).toBe('Hello Ola')
  })

  it('confines FileRead to the selected source folder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-translation-'))
    tempDirectories.push(directory)
    await writeFile(join(directory, 'source.txt'), 'opaque source text', 'utf8')
    const tools = Object.fromEntries(
      createTranslationRuntimeTools().map((tool) => [tool.name, tool])
    )
    const context = { run: run(directory), signal: new AbortController().signal }
    expect(
      await tools.FileRead.execute(tools.FileRead.validate({ file_path: 'source.txt' }), context)
    ).toBe('opaque source text')
    await expect(
      tools.FileRead.resources(tools.FileRead.validate({ file_path: '../outside.txt' }), context)
    ).rejects.toThrow('TOOL_PATH_FORBIDDEN')
  })
})
