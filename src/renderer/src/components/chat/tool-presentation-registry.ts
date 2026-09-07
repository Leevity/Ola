import type { ToolCapabilityMeta } from '@renderer/lib/tools/tool-types'
import type { ToolExecutionCategory, ToolExecutionStatus } from './execution-outline'

export interface ToolPresentation {
  category: ToolExecutionCategory
  title: string
  target?: string
  source: ToolCapabilityMeta['source']
  riskLevel: ToolCapabilityMeta['riskLevel']
  readOnly: boolean
  requiresApproval: boolean
}

export interface ToolPresentationAdapter {
  id: string
  matches: (name: string) => boolean
  present: (
    name: string,
    input: Record<string, unknown>,
    status?: ToolExecutionStatus
  ) => ToolPresentation
}

function targetFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'cwd', 'url', 'query', 'command', 'target']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400)
  }
  return undefined
}

function adapter(
  id: string,
  pattern: RegExp,
  category: ToolExecutionCategory,
  options: Partial<ToolPresentation>
): ToolPresentationAdapter {
  return {
    id,
    matches: (name) => pattern.test(name),
    present: (name, input) => ({
      category,
      title: name,
      target: targetFromInput(input),
      source: 'core',
      riskLevel: 'low',
      readOnly: false,
      requiresApproval: false,
      ...options
    })
  }
}

const adapters: ToolPresentationAdapter[] = [
  adapter('context', /^(Read|Grep|Glob|LS|Memory|WebSearch|WebFetch)$/i, 'context', {
    readOnly: true
  }),
  adapter('command', /^(Bash|Shell|PowerShell)$/i, 'command', {
    riskLevel: 'high',
    requiresApproval: true
  }),
  adapter('file-change', /^(Write|Edit|Delete|SavePlan)$/i, 'file-change', {
    riskLevel: 'high',
    requiresApproval: true
  }),
  adapter('interactive', /^(AskUserQuestion|ExitPlanMode)$/i, 'interactive', {
    readOnly: true
  }),
  adapter('orchestration', /^(Task|Team|SendMessage|SubAgent)/i, 'orchestration', {}),
  adapter('browser', /^(browser|webview)[_:.-]/i, 'browser', {
    riskLevel: 'medium',
    requiresApproval: true
  }),
  adapter('desktop', /^desktop[_:.-]/i, 'desktop', {
    riskLevel: 'high',
    requiresApproval: true
  }),
  adapter('visual', /(?:image|visual|artifact|download|screenshot)/i, 'visual', {}),
  adapter('project-intelligence', /(?:codegraph|wiki|project[_:.-]?intelligence)/i, 'mcp', {
    source: 'plugin',
    readOnly: true
  }),
  adapter('mcp-extension', /^(mcp|plugin)[_:.-]|__/i, 'mcp', {
    source: 'mcp',
    riskLevel: 'medium'
  })
]

export class ToolPresentationRegistry {
  private readonly adapters: ToolPresentationAdapter[] = [...adapters]

  register(adapter: ToolPresentationAdapter): () => void {
    this.adapters.unshift(adapter)
    return () => {
      const index = this.adapters.indexOf(adapter)
      if (index >= 0) this.adapters.splice(index, 1)
    }
  }

  resolve(
    name: string,
    input: Record<string, unknown>,
    status?: ToolExecutionStatus
  ): ToolPresentation {
    const match = this.adapters.find((candidate) => candidate.matches(name))
    if (match) return match.present(name, input, status)
    return {
      category: 'unknown',
      title: name || 'Unknown tool',
      target: targetFromInput(input),
      source: 'core',
      riskLevel: 'medium',
      readOnly: false,
      requiresApproval: status === 'pending-approval'
    }
  }
}

export const toolPresentationRegistry = new ToolPresentationRegistry()
