import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeWorkspaceId: 'local-personal',
  remoteWorkspaces: [] as Array<{ id: string; kind: 'ola-team'; name: string }>,
  switchWorkspace: vi.fn(async () => true)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? ''
  })
}))
vi.mock('@renderer/lib/switch-workspace', () => ({
  switchWorkspace: state.switchWorkspace
}))
vi.mock('@renderer/stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (value: unknown) => unknown) =>
    selector({
      activeWorkspaceId: state.activeWorkspaceId,
      olaWorkspaces: state.remoteWorkspaces
    })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { WorkspaceTabStrip } from '../../src/renderer/src/components/layout/WorkspaceTabStrip'

describe('workspace tab strip rendering', () => {
  afterEach(() => {
    state.activeWorkspaceId = 'local-personal'
    state.remoteWorkspaces = []
    state.switchWorkspace.mockClear()
  })

  it('adds no tab strip when there is only one workspace', () => {
    expect(renderToStaticMarkup(createElement(WorkspaceTabStrip))).toBe('')
  })

  it('renders an accessible selected tab for each available workspace', () => {
    state.remoteWorkspaces = [{ id: 'team-a', kind: 'ola-team', name: 'Engineering' }]
    const html = renderToStaticMarkup(createElement(WorkspaceTabStrip))

    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Workspaces"')
    expect(html).toContain(
      'role="tab" data-workspace-id="local-personal" aria-selected="true" tabindex="0"'
    )
    expect(html).toContain('Personal')
    expect(html).toContain('Engineering')
    expect(html).toContain('aria-selected="false" tabindex="-1"')
  })
})
