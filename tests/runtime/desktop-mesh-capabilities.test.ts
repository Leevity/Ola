import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, safeStorage: {} }))

import { desktopMeshCapabilities } from '../../src/main/remote/mesh-node'

describe('desktop Mesh capabilities', () => {
  it('advertises the event inbox and task execution', () => {
    expect(desktopMeshCapabilities()).toEqual([
      { id: 'mesh.event.receive', risk: 'low', version: '1' },
      { id: 'task.execute', risk: 'high', version: '1' }
    ])
  })

  it('marks task execution as high risk because it can start an Agent run', () => {
    const task = desktopMeshCapabilities().find((capability) => capability.id === 'task.execute')
    expect(task?.risk).toBe('high')
  })
})
