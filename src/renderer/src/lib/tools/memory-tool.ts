import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import {
  loadLayeredMemorySnapshot,
  type LayeredMemorySnapshot,
  type MemoryLayerEntry
} from '../agent/memory-files'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

const MEMORY_READ_FILES = ['memory_summary.md', 'MEMORY.md', 'USER.md', 'raw_memories.md'] as const

function scopeOf(input: Record<string, unknown>): 'global' | 'project' | 'both' {
  return input.scope === 'global' || input.scope === 'project' ? input.scope : 'both'
}

function lines(content: string | undefined): Array<{ line: number; text: string }> {
  return (content ?? '').split(/\r?\n/).map((text, index) => ({ line: index + 1, text }))
}

const listHandler: ToolHandler = {
  definition: {
    name: 'MemoryList',
    description:
      'List available Ola memory roots. Use before reading memory so citations can distinguish global and project memory.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project', 'both'],
          description: 'Which memory scope to list. Defaults to both.'
        }
      },
      required: []
    }
  },
  execute: async (input, ctx) => {
    const scope = scopeOf(input)
    const snapshot = await loadLayeredMemorySnapshot(ctx.ipc, {
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      workingFolder: ctx.workingFolder,
      scope: 'main'
    })
    const roots: Array<{ scope: 'global' | 'project'; memoryRootId: string; path: string }> = []
    if ((scope === 'global' || scope === 'both') && snapshot.globalHomePath)
      roots.push({
        scope: 'global',
        memoryRootId: snapshot.globalHomePath,
        path: snapshot.globalHomePath
      })
    if ((scope === 'project' || scope === 'both') && snapshot.projectMemoryHomePath)
      roots.push({
        scope: 'project',
        memoryRootId: snapshot.projectMemoryHomePath,
        path: snapshot.projectMemoryHomePath
      })
    return encodeStructuredToolResult({ roots })
  },
  requiresApproval: () => false
}

const readHandler: ToolHandler = {
  definition: {
    name: 'MemoryRead',
    description:
      'Read a scoped Ola memory file. The result includes scope, memoryRootId, path, and numbered lines for citation.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project', 'both'] },
        memoryRootId: { type: 'string', description: 'Specific memory root id from MemoryList' },
        file: {
          type: 'string',
          enum: [...MEMORY_READ_FILES],
          description: 'Memory file to read. Defaults to memory_summary.md.'
        }
      },
      required: []
    }
  },
  execute: async (input, ctx) => {
    const scope = scopeOf(input)
    const file = MEMORY_READ_FILES.includes(input.file as (typeof MEMORY_READ_FILES)[number])
      ? (input.file as (typeof MEMORY_READ_FILES)[number])
      : 'memory_summary.md'
    const snapshot = await loadLayeredMemorySnapshot(ctx.ipc, {
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      workingFolder: ctx.workingFolder,
      scope: 'main'
    })
    const roots: Array<{ scope: 'global' | 'project'; snapshot: LayeredMemorySnapshot }> = []
    if (scope === 'global' || scope === 'both') roots.push({ scope: 'global', snapshot })
    if (scope === 'project' || scope === 'both') roots.push({ scope: 'project', snapshot })
    const results = roots.map(({ scope: rootScope, snapshot: current }) => {
      const entry =
        rootScope === 'global'
          ? file === 'memory_summary.md'
            ? current.globalMemorySummary
            : file === 'MEMORY.md'
              ? current.globalMemory
              : file === 'USER.md'
                ? current.globalUser
                : current.globalSoul
          : file === 'memory_summary.md'
            ? current.projectMemorySummary
            : file === 'MEMORY.md'
              ? current.projectMemory
              : file === 'USER.md'
                ? current.projectUser
                : current.projectSoul
      return {
        scope: rootScope,
        memoryRootId:
          rootScope === 'global' ? current.globalHomePath : current.projectMemoryHomePath,
        path: entry?.path,
        file,
        lines: lines(entry?.content)
      }
    })
    return encodeStructuredToolResult({ results })
  },
  requiresApproval: () => false
}

const searchHandler: ToolHandler = {
  definition: {
    name: 'MemorySearch',
    description:
      'Search scoped Ola memory files. Results include scope, memoryRootId, path, line, and text for citation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to search for' },
        scope: { type: 'string', enum: ['global', 'project', 'both'] },
        limit: { type: 'number', description: 'Maximum matches to return, default 20' }
      },
      required: ['query']
    }
  },
  execute: async (input, ctx) => {
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    if (!query) return encodeStructuredToolResult({ results: [] })
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(Math.trunc(input.limit), 100))
        : 20
    const scope = scopeOf(input)
    const snapshot = await loadLayeredMemorySnapshot(ctx.ipc, {
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      workingFolder: ctx.workingFolder,
      scope: 'main'
    })
    const candidates: Array<{
      scope: 'global' | 'project'
      entry: MemoryLayerEntry | undefined
    }> = [
      ...(scope === 'project'
        ? []
        : [
            { scope: 'global' as const, entry: snapshot.globalMemory },
            { scope: 'global' as const, entry: snapshot.globalUser },
            { scope: 'global' as const, entry: snapshot.globalSoul },
            { scope: 'global' as const, entry: snapshot.globalMemorySummary }
          ]),
      ...(scope === 'global'
        ? []
        : [
            { scope: 'project' as const, entry: snapshot.projectMemory },
            { scope: 'project' as const, entry: snapshot.projectUser },
            { scope: 'project' as const, entry: snapshot.projectSoul },
            { scope: 'project' as const, entry: snapshot.projectMemorySummary }
          ])
    ]
    const results = candidates
      .flatMap(({ scope: rootScope, entry }) =>
        lines(entry?.content)
          .filter(({ text }) => text.toLowerCase().includes(query))
          .map(({ line, text }) => ({
            scope: rootScope,
            memoryRootId:
              rootScope === 'global' ? snapshot.globalHomePath : snapshot.projectMemoryHomePath,
            path: entry?.path,
            line,
            text
          }))
      )
      .slice(0, limit)
    return encodeStructuredToolResult({ results })
  },
  requiresApproval: () => false
}

export function registerMemoryTools(): void {
  toolRegistry.register(listHandler)
  toolRegistry.register(readHandler)
  toolRegistry.register(searchHandler)
}
