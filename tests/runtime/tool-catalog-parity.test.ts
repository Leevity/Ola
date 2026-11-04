import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PROTOCOL_TOOLS,
  WORKSPACE_PROTOCOL_TOOL_NAMES,
  type WorkspaceProtocolInputSchema,
  type WorkspaceProtocolTool
} from '../../src/shared/tool-catalog/workspace-protocol'
import { toolRegistry } from '../../src/renderer/src/lib/agent/tool-registry'
import { registerBashTools } from '../../src/renderer/src/lib/tools/bash-tool'
import { registerCodeCompatibleTools } from '../../src/renderer/src/lib/tools/code-compatible-tool'
import { registerFsTools } from '../../src/renderer/src/lib/tools/fs-tool'
import { registerSearchTools } from '../../src/renderer/src/lib/tools/search-tool'
import {
  createLegacyBashTool,
  createLegacyEditTool,
  createLegacyGlobTool,
  createLegacyGrepTool,
  createLegacyListDirectoryTool,
  createLegacyMonitorTool,
  createLegacyNotebookEditTool,
  createLegacyPowerShellTool,
  createLegacyReadTool,
  createLegacyWriteTool
} from '../../src/runtime/tools/workspace-tools'

const root = process.cwd()

interface CatalogEntry {
  name: string
  description: string
  inputSchema: WorkspaceProtocolInputSchema
  effect?: 'read' | 'write'
}

const mainCatalog = new Map<string, CatalogEntry>(
  [
    createLegacyReadTool(root),
    createLegacyWriteTool(root),
    createLegacyEditTool(root),
    createLegacyNotebookEditTool(root),
    createLegacyListDirectoryTool(root),
    createLegacyGlobTool(root),
    createLegacyGrepTool(root),
    createLegacyBashTool(root),
    createLegacyMonitorTool(root),
    createLegacyPowerShellTool(root)
  ].map((tool) => [
    tool.name,
    {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as WorkspaceProtocolInputSchema,
      effect: tool.effect
    }
  ])
)

function collectRendererCatalog(): Map<string, CatalogEntry> {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { ola: { desktop: { platform: 'win32' } } }
  try {
    registerFsTools()
    registerSearchTools()
    registerBashTools()
    registerCodeCompatibleTools()
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
  return new Map(
    toolRegistry.getDefinitions().map((tool) => [
      tool.name,
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as WorkspaceProtocolInputSchema
      }
    ])
  )
}

const rendererCatalog = collectRendererCatalog()

function specOf(name: keyof typeof WORKSPACE_PROTOCOL_TOOLS): WorkspaceProtocolTool {
  return WORKSPACE_PROTOCOL_TOOLS[name]
}

describe('workspace protocol tool catalog', () => {
  it('is the exact set both sides declare', () => {
    expect([...mainCatalog.keys()].sort()).toEqual([...WORKSPACE_PROTOCOL_TOOL_NAMES].sort())
    expect([...rendererCatalog.keys()].sort()).toEqual([...WORKSPACE_PROTOCOL_TOOL_NAMES].sort())
  })

  it('publishes the same name, description and schema on both sides', () => {
    for (const name of WORKSPACE_PROTOCOL_TOOL_NAMES) {
      const spec = specOf(name)
      const main = mainCatalog.get(name)
      const renderer = rendererCatalog.get(name)
      expect(main, `${name} is missing from Main`).toBeDefined()
      expect(renderer, `${name} is missing from the Renderer`).toBeDefined()

      // The catalog entry is the contract, so a divergence here means one side
      // is advertising something the other cannot honour.
      expect(main?.name).toBe(spec.name)
      expect(main?.description).toBe(spec.description)
      expect(main?.inputSchema).toEqual(spec.inputSchema)
      expect(main?.effect).toBe(spec.effect)

      expect(renderer?.name).toBe(spec.name)
      expect(renderer?.description).toBe(spec.description)
      expect(renderer?.inputSchema).toEqual(spec.inputSchema)
    }
  })

  it('only advertises fields Main accepts', () => {
    for (const name of WORKSPACE_PROTOCOL_TOOL_NAMES) {
      const schema = specOf(name).inputSchema
      expect(schema.additionalProperties, `${name} must reject unknown fields`).toBe(false)
      for (const field of schema.required ?? []) {
        expect(
          Object.keys(schema.properties),
          `${name}.${field} is required but undeclared`
        ).toContain(field)
      }
    }
  })
})
