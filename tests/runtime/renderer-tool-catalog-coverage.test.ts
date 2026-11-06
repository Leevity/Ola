import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toolRegistry } from '../../src/renderer/src/lib/agent/tool-registry'
import {
  isUnmigratedTsRuntimeCapabilityTool,
  supportsTsRuntimeAgentTools,
  TS_RUNTIME_UNMIGRATED_CAPABILITY_TOOLS
} from '../../src/renderer/src/lib/ipc/ts-runtime-text-eligibility'
import {
  RUN_CAPABILITY_LABEL_KEYS,
  runCapabilityLabels
} from '../../src/renderer/src/lib/run-capability-labels'
import { APP_PLUGIN_DESCRIPTORS } from '../../src/renderer/src/lib/app-plugin/types'
import { registerTaskTools } from '../../src/renderer/src/lib/tools/todo-tool'
import { registerFsTools } from '../../src/renderer/src/lib/tools/fs-tool'
import { registerSearchTools } from '../../src/renderer/src/lib/tools/search-tool'
import { registerWebSearchTool } from '../../src/renderer/src/lib/tools/web-search-tool'
import { registerBashTools } from '../../src/renderer/src/lib/tools/bash-tool'
import { registerWidgetTools } from '../../src/renderer/src/lib/tools/widget-tool'
import { registerAskUserTools } from '../../src/renderer/src/lib/tools/ask-user-tool'
import { registerPlanTools } from '../../src/renderer/src/lib/tools/plan-tool'
import { registerCronTools } from '../../src/renderer/src/lib/tools/cron-tool'
import { registerNotifyTool } from '../../src/renderer/src/lib/tools/notify-tool'
import { registerGoalTools } from '../../src/renderer/src/lib/tools/goal-tool'
import { registerMemoryTools } from '../../src/renderer/src/lib/tools/memory-tool'
import { registerCodeCompatibleTools } from '../../src/renderer/src/lib/tools/code-compatible-tool'
import { registerCanvasTool } from '../../src/renderer/src/lib/tools/canvas-tool'
import { registerVideoGenerationTool } from '../../src/renderer/src/lib/tools/video-generation-tool'
import { registerTeamTools } from '../../src/renderer/src/lib/agent/teams/register'

/**
 * A tool name the TS runtime has never heard of used to be enough to take the whole conversation
 * down: the eligibility gate answered `TOOLS_NOT_MIGRATED` and chat stopped working the moment
 * someone switched a setting or installed a plugin. Registration is decentralized on purpose
 * (`toolRegistry.register` from any module), so the only durable defense is a gate that re-reads
 * the production wiring on every run.
 */
/**
 * A tool name the TS runtime has never heard of used to be enough to take the whole conversation
 * down: the eligibility gate answered `TOOLS_NOT_MIGRATED` and chat stopped working the moment
 * someone switched a setting or installed a plugin. Registration is decentralized on purpose
 * (`toolRegistry.register` from any module), so the only durable defense is a gate that re-reads
 * the production wiring on every run.
 */
const CATALOG_REGISTRATIONS: Record<string, () => void> = {
  registerTaskTools,
  registerFsTools,
  registerSearchTools,
  registerWebSearchTool,
  registerBashTools,
  registerWidgetTools,
  registerAskUserTools,
  registerPlanTools,
  registerCronTools,
  registerNotifyTool,
  registerGoalTools,
  registerMemoryTools,
  registerCodeCompatibleTools,
  registerCanvasTool,
  registerVideoGenerationTool,
  registerTeamTools
}

// The settings-gated entries in `registerAllTools` wrap their registrar, so the gate follows
// the wrapper to the function that actually publishes the name.
const WRAPPED_REGISTRATIONS: Record<string, string> = {
  updateCanvasToolRegistration: 'registerCanvasTool',
  updateVideoGenerationToolRegistration: 'registerVideoGenerationTool',
  updateWebSearchToolRegistration: 'registerWebSearchTool'
}

function registeredToolNames(): string[] {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { ola: { desktop: { platform: 'win32' } } }
  try {
    for (const register of Object.values(CATALOG_REGISTRATIONS)) register()
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
  return toolRegistry.getStableDefinitions().map((tool) => tool.name)
}

function isCovered(name: string): boolean {
  if (isUnmigratedTsRuntimeCapabilityTool(name)) return true
  if (name.startsWith('extension__') || name.startsWith('mcp__')) return true
  return supportsTsRuntimeAgentTools({ toolNames: [name], workingDirectory: '/workspace' })
}

const LOCALE_ROOT = resolve('src/renderer/src/locales')

function localeDirectories(): string[] {
  return readdirSync(LOCALE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function nestedString(catalog: Record<string, unknown>, dottedKey: string): unknown {
  return dottedKey
    .split('.')
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
      catalog
    )
}

describe('renderer tool catalog coverage of the TS runtime', () => {
  it('registers every name the production catalog can publish', () => {
    const wiring = readFileSync(resolve('src/renderer/src/lib/tools/index.ts'), 'utf8')
    const declared = [
      ...new Set(
        [...wiring.matchAll(/\b(register[A-Za-z]+|update[A-Za-z]+ToolRegistration)\(/g)]
          .map((match) => match[1])
          .filter((name) => name !== 'registerAllTools')
          .map((name) => WRAPPED_REGISTRATIONS[name] ?? name)
      )
    ]

    // A new registrar wired into `registerAllTools` has to be named here, which is the point:
    // whoever adds the tool also says whether the runtime can execute it.
    expect(declared.filter((name) => !(name in CATALOG_REGISTRATIONS))).toEqual([])
    expect(Object.keys(CATALOG_REGISTRATIONS).sort()).toEqual([...declared].sort())
  })

  it('keeps every static catalog name executable by the TS runtime', () => {
    const uncovered = registeredToolNames().filter((name) => !isCovered(name))
    expect(uncovered).toEqual([])
  })

  it('keeps every settings-gated plugin tool name executable or quarantined', () => {
    const pluginToolNames = [
      ...new Set(
        APP_PLUGIN_DESCRIPTORS.flatMap((descriptor) => descriptor.toolNames as readonly string[])
      )
    ]
    expect(pluginToolNames.length).toBeGreaterThan(0)
    expect(pluginToolNames.filter((name) => !isCovered(name))).toEqual([])
  })

  it('quarantines only names the catalog actually publishes', () => {
    const published = new Set([
      ...registeredToolNames(),
      ...APP_PLUGIN_DESCRIPTORS.flatMap((descriptor) => descriptor.toolNames as readonly string[])
    ])

    // A stale quarantine reads like a live gap and would let the next unmigrated tool hide
    // behind the list, so every entry must still be a name the catalog publishes.
    const stale = [...published].filter(isUnmigratedTsRuntimeCapabilityTool)
    expect(stale.sort()).toEqual([...TS_RUNTIME_UNMIGRATED_CAPABILITY_TOOLS].sort())
  })

  it('names every quarantined capability in every language', () => {
    expect(Object.keys(RUN_CAPABILITY_LABEL_KEYS).sort()).toEqual(
      [...TS_RUNTIME_UNMIGRATED_CAPABILITY_TOOLS].sort()
    )
    // The five desktop-control tools are one capability, so the notice says it once.
    expect(
      runCapabilityLabels(['DesktopClick', 'DesktopType', 'DesktopWait'], (key) => key)
    ).toEqual(['runCapability.desktop'])
    const labelKeys = [
      ...new Set([...Object.values(RUN_CAPABILITY_LABEL_KEYS), 'runCapability.notice'])
    ].sort()

    for (const locale of localeDirectories()) {
      const catalog = JSON.parse(
        readFileSync(resolve(LOCALE_ROOT, locale, 'chat.json'), 'utf8')
      ) as Record<string, unknown>
      for (const key of labelKeys) {
        expect(nestedString(catalog, key), `${locale} is missing ${key}`).toBeTypeOf('string')
      }
      // The notice lists the dropped capabilities through this placeholder, so a translation that
      // loses it would silently drop the names the user needs to see.
      const detail = nestedString(catalog, 'runCapability.detail')
      expect(detail, `${locale} drops the {{tools}} placeholder`).toContain('{{tools}}')
    }
  })
})
