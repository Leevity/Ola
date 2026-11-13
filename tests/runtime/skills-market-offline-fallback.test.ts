import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@renderer/lib/ipc/ipc-client', () => ({
  ipcClient: { invoke: (...args: unknown[]) => state.invoke(...args) }
}))
vi.mock('@renderer/lib/tools/dynamic-tool-catalog', () => ({
  refreshDynamicToolCatalog: vi.fn(async () => undefined)
}))
vi.mock('@renderer/stores/settings-store', () => ({
  useSettingsStore: { getState: () => ({ skillsMarketApiKey: '' }) }
}))

import { useSkillsStore } from '../../src/renderer/src/stores/skills-store'

const localSkills = [
  { name: 'pdf', description: 'PDF 处理' },
  { name: 'xlsx', description: '表格处理' }
]

describe('skills market offline fallback', () => {
  beforeEach(() => {
    state.invoke.mockReset()
    useSkillsStore.setState({
      skills: [],
      loaded: false,
      marketSkills: [],
      marketTotal: 0,
      marketOffset: 0,
      marketError: null,
      marketQuery: ''
    })
  })

  it('shows locally installed skills when the market host is unreachable', async () => {
    state.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'skills:market-list')
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND skills.ola.shop')
      if (channel === 'skills:list') return localSkills
      return null
    })
    await useSkillsStore.getState().loadMarketSkills('', true)
    const next = useSkillsStore.getState()
    expect(next.marketError).toBe('network')
    expect(next.marketSkills.map((skill) => skill.id)).toEqual(['local:pdf', 'local:xlsx'])
    expect(next.marketTotal).toBe(2)
    expect(next.marketOffset).toBe(2)
  })

  it('uses the structured IPC error instead of an unhandled exception', async () => {
    state.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'skills:market-list')
        return { total: 0, skills: [], error: 'fetch failed ENOTFOUND skills.ola.shop' }
      if (channel === 'skills:list') return localSkills
      return null
    })
    await useSkillsStore.getState().loadMarketSkills('', true)
    expect(useSkillsStore.getState().marketSkills).toHaveLength(2)
    expect(useSkillsStore.getState().marketError).toBe('network')
  })

  it('filters the local fallback by the active search query', async () => {
    state.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'skills:market-list') throw new Error('ECONNRESET')
      if (channel === 'skills:list') return localSkills
      return null
    })
    await useSkillsStore.getState().loadMarketSkills('xlsx', true)
    expect(useSkillsStore.getState().marketSkills.map((skill) => skill.name)).toEqual(['xlsx'])
  })
})
