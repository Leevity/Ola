import { describe, expect, it, vi } from 'vitest'
import {
  createRequestToolDefinitionSnapshot,
  withRequestTaskToolDefinition
} from '../../src/renderer/src/lib/agent/task-profile-tool-definitions'
import type { ToolDefinition } from '../../src/renderer/src/lib/api/types'

describe('withRequestTaskToolDefinition', () => {
  it('keeps concurrent work and code requests on their own Task schema', () => {
    const shared: ToolDefinition[] = [
      { name: 'Read', description: 'Read files', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'Task',
        description: 'Last registered profile',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
    const work: ToolDefinition = {
      name: 'Task',
      description: 'Current task profile: work',
      inputSchema: { type: 'object', properties: { profile: { const: 'work' } } }
    }
    const code: ToolDefinition = {
      name: 'Task',
      description: 'Current task profile: code',
      inputSchema: { type: 'object', properties: { profile: { const: 'code' } } }
    }

    const workRequest = withRequestTaskToolDefinition(shared, work)
    const codeRequest = withRequestTaskToolDefinition(shared, code)

    expect(workRequest.find((definition) => definition.name === 'Task')).toEqual(work)
    expect(codeRequest.find((definition) => definition.name === 'Task')).toEqual(code)
    expect(shared[1].description).toBe('Last registered profile')
  })

  it('leaves catalogs without a Task tool unchanged', () => {
    const definitions: ToolDefinition[] = [
      { name: 'Read', description: 'Read files', inputSchema: { type: 'object', properties: {} } }
    ]
    const task: ToolDefinition = {
      name: 'Task',
      description: 'Task',
      inputSchema: { type: 'object', properties: {} }
    }

    expect(withRequestTaskToolDefinition(definitions, task)).toBe(definitions)
  })

  it('waits for dynamic catalog refresh before reading request definitions', async () => {
    let resolveRefresh: (() => void) | undefined
    const refreshCatalog = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const getDefinitions = vi.fn((): ToolDefinition[] => [
      {
        name: 'Task',
        description: 'global schema',
        inputSchema: { type: 'object', properties: {} }
      }
    ])
    const getTaskDefinition = vi.fn(
      (profile: 'work' | 'code'): ToolDefinition => ({
        name: 'Task',
        description: `profile:${profile}`,
        inputSchema: { type: 'object', properties: {} }
      })
    )

    const pending = createRequestToolDefinitionSnapshot({
      taskProfile: 'code',
      refreshCatalog,
      getDefinitions,
      getTaskDefinition
    })

    expect(refreshCatalog).toHaveBeenCalledWith('code')
    expect(getDefinitions).not.toHaveBeenCalled()
    resolveRefresh?.()
    const definitions = await pending

    expect(getDefinitions).toHaveBeenCalledOnce()
    expect(getTaskDefinition).toHaveBeenCalledWith('code')
    expect(definitions[0].description).toBe('profile:code')
  })

  it('does not create a request snapshot when dynamic catalog refresh fails', async () => {
    const getDefinitions = vi.fn(() => [])

    await expect(
      createRequestToolDefinitionSnapshot({
        taskProfile: 'work',
        refreshCatalog: async () => {
          throw new Error('catalog unavailable')
        },
        getDefinitions,
        getTaskDefinition: (): ToolDefinition => ({
          name: 'Task',
          description: 'Task',
          inputSchema: { type: 'object', properties: {} }
        })
      })
    ).rejects.toThrow('catalog unavailable')
    expect(getDefinitions).not.toHaveBeenCalled()
  })
})
