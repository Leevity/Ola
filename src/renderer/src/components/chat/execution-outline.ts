import type { ContentBlock, ToolResultContent } from '@renderer/lib/api/types'
import type { ToolCallState } from '@renderer/lib/agent/types'

export type ToolExecutionCategory =
  | 'context'
  | 'command'
  | 'file-change'
  | 'mcp'
  | 'browser'
  | 'desktop'
  | 'interactive'
  | 'orchestration'
  | 'visual'
  | 'internal'
  | 'unknown'

export type ToolExecutionVisibility = 'hidden' | 'ordinary' | 'force'
export type ToolExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'pending-approval'

export interface ToolExecutionItem {
  blockIndex: number
  toolUseId: string
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  category: ToolExecutionCategory
  visibility: ToolExecutionVisibility
  status: ToolExecutionStatus
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface ToolExecutionRun {
  id: string
  startBlockIndex: number
  endBlockIndex: number
  items: ToolExecutionItem[]
  visibleItems: ToolExecutionItem[]
  forcedItems: ToolExecutionItem[]
  status: ToolExecutionStatus
  defaultExpanded: boolean
  durationMs?: number
  categoryCounts: Partial<Record<ToolExecutionCategory, number>>
}

export interface BuildExecutionOutlineOptions {
  isStreaming?: boolean
  alwaysExpand?: boolean
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
  liveToolCallMap?: Map<string, ToolCallState> | null
}

const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Memory', 'WebSearch', 'WebFetch'])
const COMMAND_TOOLS = new Set(['Bash', 'Shell', 'PowerShell'])
const FILE_CHANGE_TOOLS = new Set(['Write', 'Edit', 'Delete', 'SavePlan'])
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const ORCHESTRATION_TOOLS = new Set([
  'Task',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TaskCreate',
  'TaskUpdate',
  'TaskList'
])
const INTERNAL_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList'])
const VISUAL_TOOLS = new Set([
  'image_generate',
  'visualize_show_widget',
  'download_file',
  'Download'
])

function normalizedToolName(name: string): string {
  return name.trim()
}

export function classifyTool(name: string): ToolExecutionCategory {
  const normalized = normalizedToolName(name)
  if (INTERNAL_TOOLS.has(normalized)) return 'internal'
  if (CONTEXT_TOOLS.has(normalized)) return 'context'
  if (COMMAND_TOOLS.has(normalized)) return 'command'
  if (FILE_CHANGE_TOOLS.has(normalized)) return 'file-change'
  if (INTERACTIVE_TOOLS.has(normalized)) return 'interactive'
  if (ORCHESTRATION_TOOLS.has(normalized) || /^(subagent|team)[_:.-]/i.test(normalized)) {
    return 'orchestration'
  }
  if (
    VISUAL_TOOLS.has(normalized) ||
    /(?:image|visual|artifact|download|screenshot)/i.test(normalized)
  ) {
    return 'visual'
  }
  if (/^(browser|webview)[_:.-]/i.test(normalized)) return 'browser'
  if (/^desktop[_:.-]/i.test(normalized)) return 'desktop'
  if (/^(mcp|plugin)[_:.-]/i.test(normalized) || normalized.includes('__')) return 'mcp'
  return 'unknown'
}

function resultText(content: ToolResultContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

function inferStatus(
  result: { content: ToolResultContent; isError?: boolean } | undefined,
  live: ToolCallState | undefined,
  isStreaming: boolean
): ToolExecutionStatus {
  if (live?.status === 'pending_approval') return 'pending-approval'
  if (live?.status === 'canceled') return 'canceled'
  if (live?.status === 'error' || live?.error || result?.isError) return 'failed'
  if (live?.status === 'running' || live?.status === 'streaming') return 'running'
  if (live?.status === 'completed' || result) return 'completed'
  return isStreaming ? 'running' : 'completed'
}

function inferError(
  result: { content: ToolResultContent; isError?: boolean } | undefined,
  live: ToolCallState | undefined
): string | undefined {
  if (live?.error) return live.error
  if (!result?.isError) return undefined
  const text = resultText(result.content).trim()
  return text || undefined
}

function visibilityFor(
  category: ToolExecutionCategory,
  status: ToolExecutionStatus
): ToolExecutionVisibility {
  if (category === 'internal') return status === 'failed' ? 'force' : 'hidden'
  if (
    status === 'running' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'pending-approval'
  ) {
    return 'force'
  }
  if (category === 'interactive' || category === 'visual' || category === 'orchestration') {
    return 'force'
  }
  return 'ordinary'
}

function runStatus(items: ToolExecutionItem[]): ToolExecutionStatus {
  if (items.some((item) => item.status === 'pending-approval')) return 'pending-approval'
  if (items.some((item) => item.status === 'failed')) return 'failed'
  if (items.some((item) => item.status === 'running')) return 'running'
  if (items.some((item) => item.status === 'canceled')) return 'canceled'
  return 'completed'
}

function finalizeRun(items: ToolExecutionItem[], alwaysExpand: boolean): ToolExecutionRun | null {
  if (items.length === 0) return null
  const visibleItems = items.filter((item) => item.visibility !== 'hidden')
  if (visibleItems.length === 0) return null
  const forcedItems = visibleItems.filter((item) => item.visibility === 'force')
  const startedAt = visibleItems.reduce<number | undefined>(
    (earliest, item) =>
      item.startedAt === undefined
        ? earliest
        : earliest === undefined
          ? item.startedAt
          : Math.min(earliest, item.startedAt),
    undefined
  )
  const completedAt = visibleItems.reduce<number | undefined>(
    (latest, item) =>
      item.completedAt === undefined
        ? latest
        : latest === undefined
          ? item.completedAt
          : Math.max(latest, item.completedAt),
    undefined
  )
  const categoryCounts: Partial<Record<ToolExecutionCategory, number>> = {}
  for (const item of visibleItems) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1
  }
  return {
    // The first tool id remains stable while streaming appends more steps to this run.
    id: visibleItems[0].toolUseId,
    startBlockIndex: items[0].blockIndex,
    endBlockIndex: items.at(-1)!.blockIndex,
    items,
    visibleItems,
    forcedItems,
    status: runStatus(visibleItems),
    defaultExpanded: alwaysExpand || forcedItems.length > 0,
    ...(startedAt !== undefined && completedAt !== undefined
      ? { durationMs: Math.max(0, completedAt - startedAt) }
      : {}),
    categoryCounts
  }
}

export function buildExecutionOutline(
  blocks: ContentBlock[] | null,
  options: BuildExecutionOutlineOptions = {}
): ToolExecutionRun[] {
  if (!blocks?.length) return []
  const runs: ToolExecutionRun[] = []
  let pendingItems: ToolExecutionItem[] = []

  const flush = (): void => {
    const run = finalizeRun(pendingItems, options.alwaysExpand === true)
    if (run) runs.push(run)
    pendingItems = []
  }

  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type !== 'tool_use') {
      flush()
      continue
    }
    const result = options.toolResults?.get(block.id)
    const live = options.liveToolCallMap?.get(block.id)
    const status = inferStatus(result, live, options.isStreaming === true)
    const category = classifyTool(block.name)
    pendingItems.push({
      blockIndex,
      toolUseId: block.id,
      name: block.name,
      input: live?.input && Object.keys(live.input).length > 0 ? live.input : block.input,
      output: result?.content ?? live?.output,
      category,
      visibility: visibilityFor(category, status),
      status,
      ...(inferError(result, live) ? { error: inferError(result, live) } : {}),
      ...(live?.startedAt === undefined ? {} : { startedAt: live.startedAt }),
      ...(live?.completedAt === undefined ? {} : { completedAt: live.completedAt })
    })
  }
  flush()
  return runs
}

export function shouldRenderToolOutsideCollapsedRun(item: ToolExecutionItem): boolean {
  return item.visibility === 'force'
}
