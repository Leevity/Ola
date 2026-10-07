import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  refresh: vi.fn(),
  registered: (name: string) => () => fixture.calls.push(name)
}))

vi.mock('../../src/renderer/src/lib/tools/todo-tool', () => ({
  registerTaskTools: fixture.registered('task')
}))
vi.mock('../../src/renderer/src/lib/tools/fs-tool', () => ({
  registerFsTools: fixture.registered('fs')
}))
vi.mock('../../src/renderer/src/lib/tools/search-tool', () => ({
  registerSearchTools: fixture.registered('search')
}))
vi.mock('../../src/renderer/src/lib/tools/web-search-tool', () => ({
  registerWebSearchTool: vi.fn(),
  unregisterWebSearchTool: vi.fn(),
  isWebSearchToolRegistered: () => false
}))
vi.mock('../../src/renderer/src/lib/tools/bash-tool', () => ({
  registerBashTools: fixture.registered('bash')
}))
vi.mock('../../src/renderer/src/lib/agent/teams/register', () => ({
  registerTeamTools: fixture.registered('team')
}))
vi.mock('../../src/renderer/src/lib/tools/widget-tool', () => ({
  registerWidgetTools: fixture.registered('widget')
}))
vi.mock('../../src/renderer/src/lib/tools/ask-user-tool', () => ({
  registerAskUserTools: fixture.registered('ask-user')
}))
vi.mock('../../src/renderer/src/lib/tools/plan-tool', () => ({
  registerPlanTools: fixture.registered('plan')
}))
vi.mock('../../src/renderer/src/lib/tools/cron-tool', () => ({
  registerCronTools: fixture.registered('cron')
}))
vi.mock('../../src/renderer/src/lib/tools/notify-tool', () => ({
  registerNotifyTool: fixture.registered('notify')
}))
vi.mock('../../src/renderer/src/lib/tools/goal-tool', () => ({
  registerGoalTools: fixture.registered('goal')
}))
vi.mock('../../src/renderer/src/lib/tools/memory-tool', () => ({
  registerMemoryTools: fixture.registered('memory')
}))
vi.mock('../../src/renderer/src/lib/tools/dynamic-tool-catalog', () => ({
  refreshDynamicToolCatalog: fixture.refresh,
  ensureRequestToolCatalogFresh: vi.fn()
}))
vi.mock('../../src/renderer/src/lib/tools/code-compatible-tool', () => ({
  registerCodeCompatibleTools: fixture.registered('code-compatible')
}))
vi.mock('../../src/renderer/src/lib/tools/canvas-tool', () => ({
  isCanvasToolRegistered: () => false,
  registerCanvasTool: vi.fn(),
  unregisterCanvasTool: vi.fn()
}))
vi.mock('../../src/renderer/src/lib/tools/video-generation-tool', () => ({
  isVideoGenerationToolRegistered: () => false,
  registerVideoGenerationTool: vi.fn(),
  unregisterVideoGenerationTool: vi.fn()
}))
vi.mock('../../src/renderer/src/stores/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({ advancedDrawEnabled: false, videoGenerationEnabled: false })
  }
}))

import { registerAllTools } from '../../src/renderer/src/lib/tools'

it('keeps static tools registered and retries the dynamic catalog after failure', async () => {
  fixture.refresh
    .mockRejectedValueOnce(new Error('catalog unavailable'))
    .mockResolvedValueOnce(undefined)

  await expect(registerAllTools()).rejects.toThrow('catalog unavailable')
  expect(fixture.calls).toContain('task')
  expect(fixture.calls).toContain('code-compatible')
  expect(fixture.calls).toContain('team')
  const staticCalls = [...fixture.calls]

  await expect(registerAllTools()).resolves.toBeUndefined()
  expect(fixture.calls).toEqual(staticCalls)
  expect(fixture.refresh).toHaveBeenCalledTimes(2)

  await registerAllTools()
  expect(fixture.refresh).toHaveBeenCalledTimes(2)
})
