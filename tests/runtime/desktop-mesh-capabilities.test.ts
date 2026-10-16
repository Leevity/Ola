import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, safeStorage: {} }))

import { desktopMeshCapabilities } from '../../src/main/remote/mesh-node'

describe('desktop Mesh capabilities', () => {
  it('advertises only the event inbox backed by the remote workspace', () => {
    expect(desktopMeshCapabilities()).toEqual([
      { id: 'mesh.event.receive', risk: 'low', version: '1' }
    ])
    expect(desktopMeshCapabilities().some((capability) => capability.id === 'task.execute')).toBe(
      false
    )
  })
})
