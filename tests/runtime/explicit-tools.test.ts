import { describe, expect, it } from 'vitest'
import { selectExplicitTools } from '../../src/runtime/tools/explicit-tools'
import type { ToolDefinition } from '../../src/runtime/tools/tool-executor'

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: {},
  effect: 'read',
  validate: (input) => input,
  resources: async () => [],
  execute: async () => name
})

describe('explicit runtime tool snapshots', () => {
  const available = [tool('web_fetch'), tool('web_search'), tool('write_file')]

  it('does not grant ambient tools when a run has no snapshot', () => {
    expect(selectExplicitTools(available, undefined)).toEqual([])
    expect(selectExplicitTools(available, [])).toEqual([])
  })

  it('intersects a run snapshot with host-provided capabilities', () => {
    expect(selectExplicitTools(available, ['web_search', 'missing'])).toEqual([available[1]])
  })
})
