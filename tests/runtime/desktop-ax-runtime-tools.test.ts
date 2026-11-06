import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDesktopAxRuntimeTools } from '../../src/main/runtime/desktop-ax-runtime-tools'
import {
  DESKTOP_AX_ADJUST_TOOL,
  DESKTOP_AX_CLICK_TOOL,
  DESKTOP_AX_INSPECT_TOOL,
  DESKTOP_AX_INPUT_TEXT_TOOL,
  DESKTOP_AX_LAUNCH_TOOL,
  DESKTOP_AX_LIST_TOOL,
  DESKTOP_AX_SNAPSHOT_TOOL,
  type AgentDesktopToolName
} from '../../src/main/agent-desktop/args'
import type { AgentDesktopStatus } from '../../src/main/agent-desktop/detector'
import {
  SNAPSHOT_MAX_CHARS,
  UI_SNAPSHOT_END,
  UI_SNAPSHOT_PREAMBLE
} from '../../src/main/agent-desktop/snapshot-shrink'
import { RuntimeError, type RunSpec } from '../../src/shared/runtime/contracts'
import type { ToolContext, ToolDefinition } from '../../src/runtime/tools/tool-executor'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  systemPreferences: { isTrustedAccessibilityClient: () => true }
}))

const fixturePath = resolve('tests/fixtures/fake-agent-desktop.mjs')

/**
 * The fake CLI is a shebang script and Windows cannot spawn one, so the cases that read its output
 * or count its spawns run only where the host can start it. The Windows job still proves argv
 * construction, the shrinker, the detector and the approval gate, which is where Windows behavior
 * actually differs from macOS; the real spawn path on Windows is the human UIA acceptance row.
 */
const againstFakeCli = process.platform === 'win32' ? it.skip : it

const ready: AgentDesktopStatus = {
  available: true,
  platform: 'macos',
  backend: 'ax',
  binaryPath: fixturePath,
  accessibility: 'granted',
  installHint: null,
  installHintCode: null
}

const unavailable: AgentDesktopStatus = {
  ...ready,
  available: false,
  accessibility: 'denied',
  installHint: 'Grant Accessibility access to Ola.',
  installHintCode: 'accessibility-permission'
}

let stateRoot: string

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'ola-desktop-ax-'))
})

function contextFor(run: Partial<RunSpec> = {}): ToolContext {
  return {
    run: {
      runId: 'run-1',
      taskId: 'task-1',
      requestId: 'request',
      traceId: 'trace',
      sessionId: 'session-1',
      workspaceId: 'local-personal',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
      prompt: 'prompt',
      toolNames: [DESKTOP_AX_LAUNCH_TOOL],
      unattended: false,
      ...run
    },
    signal: new AbortController().signal
  }
}

type Options = Parameters<typeof createDesktopAxRuntimeTools>[0]

function toolsFor(options: Options = {}): ToolDefinition[] {
  return createDesktopAxRuntimeTools({ stateRoot, status: ready, ...options })
}

function toolFor(name: AgentDesktopToolName, options: Options = {}): ToolDefinition {
  const tool = toolsFor(options).find((entry) => entry.name === name)
  if (!tool) throw new Error(`${name} was not registered`)
  return tool
}

function sessionDirs(): string[] {
  try {
    return readdirSync(stateRoot)
  } catch {
    return []
  }
}

function spawnCount(dir: string): number {
  try {
    return readFileSync(join(dir, 'calls.ndjson'), 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** The argv of the most recent real spawn, as the fixture recorded it. */
function lastArgv(): string[] {
  const dir = join(stateRoot, sessionDirs()[0])
  const lines = readFileSync(join(dir, 'calls.ndjson'), 'utf8').split('\n').filter(Boolean)
  return (JSON.parse(lines[lines.length - 1]) as { argv: string[] }).argv
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof RuntimeError ? error.code : 'NOT_RUNTIME_ERROR'
  }
  return 'NO_ERROR'
}

async function refusalCodeOf(
  tool: ToolDefinition,
  input: Record<string, unknown>
): Promise<string> {
  try {
    await tool.prepare?.(input, contextFor())
  } catch (error) {
    return error instanceof RuntimeError ? error.code : 'NOT_RUNTIME_ERROR'
  }
  return 'NO_ERROR'
}

describe('desktop_ax runtime tools', () => {
  it('is absent until the platform gate says the backend works', () => {
    expect(createDesktopAxRuntimeTools({ status: unavailable, stateRoot })).toEqual([])
    expect(
      createDesktopAxRuntimeTools({ status: { ...ready, binaryPath: null }, stateRoot })
    ).toEqual([])
    expect(toolFor(DESKTOP_AX_LAUNCH_TOOL).name).toBe(DESKTOP_AX_LAUNCH_TOOL)
  })

  it('registers four writers and three readers', () => {
    expect(toolsFor().map((tool) => tool.name)).toEqual([
      DESKTOP_AX_LAUNCH_TOOL,
      DESKTOP_AX_LIST_TOOL,
      DESKTOP_AX_SNAPSHOT_TOOL,
      DESKTOP_AX_INSPECT_TOOL,
      DESKTOP_AX_CLICK_TOOL,
      DESKTOP_AX_INPUT_TEXT_TOOL,
      DESKTOP_AX_ADJUST_TOOL
    ])
    const byName = new Map(toolsFor().map((tool) => [tool.name, tool]))
    for (const name of [
      DESKTOP_AX_LAUNCH_TOOL,
      DESKTOP_AX_CLICK_TOOL,
      DESKTOP_AX_INPUT_TEXT_TOOL,
      DESKTOP_AX_ADJUST_TOOL
    ] as AgentDesktopToolName[]) {
      expect(byName.get(name)?.effect, name).toBe('write')
      expect(byName.get(name)?.serializeReads, name).toBeUndefined()
    }
    for (const name of [
      DESKTOP_AX_LIST_TOOL,
      DESKTOP_AX_SNAPSHOT_TOOL,
      DESKTOP_AX_INSPECT_TOOL
    ] as AgentDesktopToolName[]) {
      expect(byName.get(name)?.effect, name).toBe('read')
    }
    // A snapshot or a search rewrites the session's ref table, so it takes the session lock the way
    // a write does; an inventory registers nothing and must not block a drill-down.
    expect(byName.get(DESKTOP_AX_LIST_TOOL)?.serializeReads).toBeUndefined()
    expect(byName.get(DESKTOP_AX_SNAPSHOT_TOOL)?.serializeReads).toBe(true)
    expect(byName.get(DESKTOP_AX_INSPECT_TOOL)?.serializeReads).toBe(true)
    for (const tool of toolsFor()) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  it('is an approval-bound write with a closed schema', () => {
    const tool = toolFor(DESKTOP_AX_LAUNCH_TOOL)
    expect(tool.effect).toBe('write')
    expect(tool.serializeReads).toBeUndefined()
    expect(() => tool.validate({ app: 'TextEdit', extra: 'x' })).toThrowError(RuntimeError)
    expect(() => tool.validate({ app: '  ' })).toThrowError(RuntimeError)
    expect(() => tool.validate({ app: 'a'.repeat(201) })).toThrowError(RuntimeError)
    expect(() => tool.validate({ app: 'TextEdit', timeoutMs: 999 })).toThrowError(RuntimeError)
    expect(tool.validate({ app: 'TextEdit' })).toMatchObject({ app: 'TextEdit' })
  })

  it('closes each reader schema to the same shape', () => {
    const invalid = (name: AgentDesktopToolName, input: unknown): string =>
      codeOf(() => toolFor(name).validate(input))

    expect(invalid(DESKTOP_AX_LIST_TOOL, { kind: 'processes' })).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_LIST_TOOL, {})).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_LIST_TOOL, { kind: 'apps', surface: 'menu' })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(invalid(DESKTOP_AX_SNAPSHOT_TOOL, {})).toBe('INVALID_TOOL_INPUT')
    // `maxDepth` is a real CLI flag whose value `--skeleton` overrides, so offering it would lie.
    expect(invalid(DESKTOP_AX_SNAPSHOT_TOOL, { app: 'TextEdit', maxDepth: 3 })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(invalid(DESKTOP_AX_SNAPSHOT_TOOL, { app: 'TextEdit', surface: 'desktop2' })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(invalid(DESKTOP_AX_SNAPSHOT_TOOL, { app: 'TextEdit', surface: 'sheet' })).toBe(
      'NO_ERROR'
    )
    // A search with no filter is a dump, and a dump is what the result budget exists to prevent.
    expect(invalid(DESKTOP_AX_INSPECT_TOOL, { app: 'TextEdit' })).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_INSPECT_TOOL, { role: 'button' })).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_INSPECT_TOOL, { app: 'TextEdit', rootRef: '@e7' })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(
      invalid(DESKTOP_AX_INSPECT_TOOL, {
        app: 'TextEdit',
        rootRef: '@s8f3k2p9:e7',
        surface: 'menu',
        role: 'button'
      })
    ).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_INSPECT_TOOL, { app: 'TextEdit', role: 'button', limit: 0 })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(invalid(DESKTOP_AX_INSPECT_TOOL, { app: 'TextEdit', role: 'button' })).toBe('NO_ERROR')
    for (const name of [
      DESKTOP_AX_LIST_TOOL,
      DESKTOP_AX_SNAPSHOT_TOOL,
      DESKTOP_AX_INSPECT_TOOL
    ] as AgentDesktopToolName[]) {
      expect(codeOf(() => toolFor(name).validate({ app: 'TextEdit', timeoutMs: NaN }))).toBe(
        'INVALID_TOOL_INPUT'
      )
    }
  })

  it('locks the run session and a hashed app identity', async () => {
    const tool = toolFor(DESKTOP_AX_LAUNCH_TOOL)
    const context = contextFor()
    const first = await tool.resources({ app: 'TextEdit' }, context)
    const sameApp = await tool.resources({ app: ' textedit ' }, context)
    const otherApp = await tool.resources({ app: 'Calculator' }, context)
    expect(first[0]).toBe(`desktop-ax:${context.run.workspaceId}:${context.run.sessionId}:session`)
    expect(first[1]).toMatch(/^desktop-ax:app:[0-9a-f]{16}$/)
    expect(first[1]).not.toContain('textedit')
    expect(sameApp).toEqual(first)
    expect(otherApp).not.toEqual(first)
  })

  it('locks only the session for an inventory that names no app', async () => {
    const context = contextFor()
    expect(await toolFor(DESKTOP_AX_LIST_TOOL).resources({ kind: 'apps' }, context)).toEqual([
      `desktop-ax:${context.run.workspaceId}:${context.run.sessionId}:session`
    ])
  })

  againstFakeCli('launches once and reports the pid', async () => {
    await toolFor(DESKTOP_AX_LAUNCH_TOOL).execute({ app: 'fake-ok' }, contextFor())
    expect(sessionDirs()).toHaveLength(1)
    expect(spawnCount(join(stateRoot, sessionDirs()[0]))).toBe(1)
  })

  againstFakeCli('repeats a not-delivered failure exactly once', async () => {
    const output = await toolFor(DESKTOP_AX_LAUNCH_TOOL).execute({ app: 'fake-perm' }, contextFor())
    expect(String(output)).toContain('agent-desktop PERM_DENIED')
    expect(String(output)).toContain('retry=safe')
    expect(sessionDirs()).toHaveLength(1)
    expect(spawnCount(join(stateRoot, sessionDirs()[0]))).toBe(2)
  })

  againstFakeCli('never repeats a delivery it cannot disprove', async () => {
    const output = await toolFor(DESKTOP_AX_LAUNCH_TOOL).execute(
      { app: 'fake-unsafe' },
      contextFor()
    )
    expect(String(output)).toContain('agent-desktop ACTION_FAILED')
    expect(String(output)).toContain('delivery=delivered_unverified')
    expect(spawnCount(join(stateRoot, sessionDirs()[0]))).toBe(1)
  })

  it('refuses an app outside the allowlist before approval and before any process starts', async () => {
    const allowedApps = ['TextEdit']
    for (const tool of toolsFor({ allowedApps })) {
      expect(await refusalCodeOf(tool, { app: 'Calculator', kind: 'apps', role: 'button' })).toBe(
        'AGENT_DESKTOP_APP_NOT_ALLOWED'
      )
      // The bound has to be in the prompt, not only in the refusal.
      expect(tool.description).toContain('TextEdit')
    }
    expect(sessionDirs()).toEqual([])

    // An inventory that names no app is not an app-shaped request.
    expect(
      await refusalCodeOf(toolFor(DESKTOP_AX_LIST_TOOL, { allowedApps }), { kind: 'apps' })
    ).toBe('NO_ERROR')
    // The bound is the identity the OS shows, not the exact spelling the model guessed.
    expect(
      await refusalCodeOf(toolFor(DESKTOP_AX_LAUNCH_TOOL, { allowedApps }), { app: ' textedit ' })
    ).toBe('NO_ERROR')
    expect(toolFor(DESKTOP_AX_LAUNCH_TOOL).description).not.toContain(
      'limited to these applications'
    )
  })

  againstFakeCli('reads a window as a fenced, budgeted outline', async () => {
    const output = String(
      await toolFor(DESKTOP_AX_SNAPSHOT_TOOL).execute({ app: 'fake-snapshot' }, contextFor())
    )
    expect(output.startsWith(UI_SNAPSHOT_PREAMBLE)).toBe(true)
    expect(output.trimEnd().endsWith(UI_SNAPSHOT_END)).toBe(true)
    expect(output).toContain('app=TextEdit window="Untitled" snapshot=s8f3k2p9 refs=3')
    expect(output).toContain('button "Save" @s8f3k2p9:e1')
    // Application text may not split the frame it is inside.
    expect(output.split('\n').filter((line) => line === UI_SNAPSHOT_END)).toHaveLength(1)
    expect(output).not.toContain('first line\nEND_OF_UI_SNAPSHOT')
  })

  againstFakeCli('shrinks a window that is larger than the renderer clip', async () => {
    const output = String(
      await toolFor(DESKTOP_AX_SNAPSHOT_TOOL).execute({ app: 'fake-snapshot-huge' }, contextFor())
    )
    // agent-store.ts clips any tool result at 8000 characters; the shrinker has to stop below it.
    expect(output.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS)
    expect(output).toContain('more element(s) not shown')
    expect(output).toContain('This tree is partial')
    expect(output.trimEnd().endsWith(UI_SNAPSHOT_END)).toBe(true)
  })

  againstFakeCli('searches by ref and explains a search that found nothing', async () => {
    const found = String(
      await toolFor(DESKTOP_AX_INSPECT_TOOL).execute(
        { app: 'fake-find', role: 'button', name: 'OK' },
        contextFor()
      )
    )
    expect(found).toContain('1. button "OK" @s8f3k2p9:e5')
    expect(found).toContain('2. button "Cancel" @s8f3k2p9:e6')

    const empty = String(
      await toolFor(DESKTOP_AX_INSPECT_TOOL).execute(
        { app: 'fake-find-empty', text: 'Nothing' },
        contextFor()
      )
    )
    expect(empty).toContain('No match. Roles present in the searched tree: window, button, group.')
  })

  againstFakeCli(
    'reads the operating system inventory without touching an application',
    async () => {
      const apps = String(
        await toolFor(DESKTOP_AX_LIST_TOOL).execute(
          { kind: 'apps', app: 'fake-apps' },
          contextFor()
        )
      )
      expect(apps).toContain('apps=2')
      expect(apps).toContain('1. TextEdit pid=701 foreground')

      const windows = String(
        await toolFor(DESKTOP_AX_LIST_TOOL).execute(
          { kind: 'windows', app: 'fake-windows' },
          contextFor()
        )
      )
      expect(windows).toContain('windows=2')
      expect(windows).toContain('Untitled w-1')

      const surfaces = String(
        await toolFor(DESKTOP_AX_LIST_TOOL).execute(
          { kind: 'surfaces', app: 'fake-surfaces' },
          contextFor()
        )
      )
      expect(surfaces).toContain('surfaces=2')
      expect(surfaces).toContain('File')
    }
  )

  it('closes each action schema to the shape the verb takes', () => {
    const invalid = (name: AgentDesktopToolName, input: unknown): string =>
      codeOf(() => toolFor(name).validate(input))

    expect(invalid(DESKTOP_AX_CLICK_TOOL, { app: 'TextEdit' })).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_CLICK_TOOL, { app: 'TextEdit', ref: '@e3' })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(
      invalid(DESKTOP_AX_CLICK_TOOL, { app: 'TextEdit', ref: '@s8f3k2p9:e3', headed: true })
    ).toBe('INVALID_TOOL_INPUT')
    expect(invalid(DESKTOP_AX_CLICK_TOOL, { app: 'TextEdit', ref: '@s8f3k2p9:e3' })).toBe(
      'NO_ERROR'
    )
    expect(invalid(DESKTOP_AX_INPUT_TEXT_TOOL, { app: 'TextEdit', ref: '@s8f3k2p9:e3' })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(
      invalid(DESKTOP_AX_INPUT_TEXT_TOOL, {
        app: 'TextEdit',
        ref: '@s8f3k2p9:e3',
        text: 'x'.repeat(321)
      })
    ).toBe('INVALID_TOOL_INPUT')
    // Physical input and undefined verbs are not on the menu, however the model spells them.
    for (const action of ['press', 'hover', 'drag', 'double-click', 'key-down', 'clear']) {
      expect(
        invalid(DESKTOP_AX_ADJUST_TOOL, { app: 'TextEdit', ref: '@s8f3k2p9:e3', action })
      ).toBe('INVALID_TOOL_INPUT')
    }
    expect(
      invalid(DESKTOP_AX_ADJUST_TOOL, { app: 'TextEdit', ref: '@s8f3k2p9:e3', action: 'select' })
    ).toBe('INVALID_TOOL_INPUT')
    expect(
      invalid(DESKTOP_AX_ADJUST_TOOL, {
        app: 'TextEdit',
        ref: '@s8f3k2p9:e3',
        action: 'toggle',
        value: 'ignored'
      })
    ).toBe('INVALID_TOOL_INPUT')
    expect(
      invalid(DESKTOP_AX_ADJUST_TOOL, { app: 'TextEdit', ref: '@s8f3k2p9:e3', action: 'scroll' })
    ).toBe('NO_ERROR')
  })

  it('locks the application an action names, the same way a launch does', async () => {
    const context = contextFor()
    const click = await toolFor(DESKTOP_AX_CLICK_TOOL).resources(
      { app: 'TextEdit', ref: '@s8f3k2p9:e1' },
      context
    )
    expect(click).toHaveLength(2)
    expect(click).toEqual(
      await toolFor(DESKTOP_AX_LAUNCH_TOOL).resources({ app: 'TextEdit' }, context)
    )
  })

  againstFakeCli('spawns the text verb the platform actually supports', async () => {
    await toolFor(DESKTOP_AX_INPUT_TEXT_TOOL).execute(
      { app: 'TextEdit', ref: '@fake-verified:e1', text: '-5 % off' },
      contextFor()
    )
    const argv = lastArgv()
    expect(argv[0]).toBe('type')
    // Free text is a positional value behind the option terminator, never a flag.
    expect(argv.slice(-2)).toEqual(['--', '-5 % off'])

    const windows = toolFor(DESKTOP_AX_INPUT_TEXT_TOOL, {
      status: { ...ready, platform: 'windows' }
    })
    await windows.execute(
      { app: 'TextEdit', ref: '@fake-verified:e1', text: 'hello' },
      contextFor()
    )
    const setArgv = lastArgv()
    expect(setArgv[0]).toBe('set-value')
    expect(setArgv.slice(-2)).toEqual(['--', 'hello'])
  })

  againstFakeCli(
    'reports an action by what the operating system proved, not by the exit code',
    async () => {
      const verified = String(
        await toolFor(DESKTOP_AX_CLICK_TOOL).execute(
          { app: 'TextEdit', ref: '@fake-verified:e1' },
          contextFor()
        )
      )
      expect(verified).toContain('Pressed @fake-verified:e1 in TextEdit')
      expect(verified).toContain('observed the change')

      const unverified = String(
        await toolFor(DESKTOP_AX_CLICK_TOOL).execute(
          { app: 'TextEdit', ref: '@fake-unverified:e1' },
          contextFor()
        )
      )
      expect(unverified).toContain('UNCONFIRMED')
      expect(unverified).toContain('Do not repeat this call')
      // `retry: unsafe` is the only honest reading of a delivery that may have landed.
      expect(spawnCount(join(stateRoot, sessionDirs()[0]))).toBe(2)

      const silent = String(
        await toolFor(DESKTOP_AX_ADJUST_TOOL).execute(
          { app: 'TextEdit', ref: '@fake-ok:e1', action: 'toggle' },
          contextFor()
        )
      )
      expect(silent).toContain('UNCONFIRMED: no delivery proof came back')
    }
  )

  againstFakeCli(
    'does not spend a second spawn on a ref the session has already lost',
    async () => {
      const output = String(
        await toolFor(DESKTOP_AX_CLICK_TOOL).execute(
          { app: 'TextEdit', ref: '@fake-stale:e1' },
          contextFor()
        )
      )
      expect(output).toContain('agent-desktop STALE_REF')
      // The CLI calls a stale ref safe to retry, and it is right that nothing was delivered. It is
      // also right that retrying the same ref cannot make it current.
      expect(output).toContain('retry=safe')
      expect(spawnCount(join(stateRoot, sessionDirs()[0]))).toBe(1)
    }
  )

  it('gives each run session its own state directory', async () => {
    const tool = toolFor(DESKTOP_AX_LAUNCH_TOOL)
    await tool.execute({ app: 'fake-ok' }, contextFor({ sessionId: 'session-a' }))
    await tool.execute({ app: 'fake-ok' }, contextFor({ sessionId: 'session-b' }))
    expect(sessionDirs()).toHaveLength(2)
  })

  it('drops abandoned session state and keeps the live one', async () => {
    const stale = join(stateRoot, 'ola-stalesession')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'snapshot.json'), '{}')
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(join(stale, 'snapshot.json'), old, old)
    utimesSync(stale, old, old)
    await toolFor(DESKTOP_AX_LAUNCH_TOOL).execute({ app: 'fake-ok' }, contextFor())
    expect(existsSync(stale)).toBe(false)
    expect(sessionDirs()).toHaveLength(1)
  })
})
