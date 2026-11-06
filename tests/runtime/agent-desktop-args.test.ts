import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  DESKTOP_AX_ADJUST_TOOL,
  DESKTOP_AX_CLICK_TOOL,
  DESKTOP_AX_INSPECT_TOOL,
  DESKTOP_AX_INPUT_TEXT_TOOL,
  DESKTOP_AX_LAUNCH_TOOL,
  DESKTOP_AX_LIST_TOOL,
  DESKTOP_AX_SNAPSHOT_TOOL,
  FORBIDDEN_ARGV_TOKENS,
  FORBIDDEN_COMMAND_NAMES,
  agentDesktopSessionScope,
  assertPlanIsAllowed,
  buildAgentDesktopPlan,
  type AgentDesktopPlan,
  type AgentDesktopScope,
  type AgentDesktopToolName
} from '../../src/main/agent-desktop/args'
import { RuntimeError } from '../../src/shared/runtime/contracts'

const scope: AgentDesktopScope = {
  session: 'ola-sessiondigest',
  agentId: 'ola-main',
  home: '/abs/root',
  platform: 'macos'
}

const windowsScope: AgentDesktopScope = { ...scope, platform: 'windows' }

const tail = ['--session', 'ola-sessiondigest', '--agent-id', 'ola-main']

const REF = '@s8f3k2p9:e5'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof RuntimeError ? error.code : 'NOT_RUNTIME_ERROR'
  }
  return 'NO_ERROR'
}

function timeoutArgOf(argv: string[]): string {
  return argv[argv.indexOf('--timeout') + 1]
}

function budgetArgOf(tool: AgentDesktopToolName, argv: string[]): string {
  const flag = tool === DESKTOP_AX_LAUNCH_TOOL ? '--timeout' : '--timeout-ms'
  return argv[argv.indexOf(flag) + 1]
}

function assertNoForbidden(argv: string[]): void {
  for (const token of argv) {
    for (const forbidden of FORBIDDEN_ARGV_TOKENS) {
      expect(token).not.toBe(forbidden)
      expect(token.startsWith(`${forbidden}=`)).toBe(false)
    }
    expect(FORBIDDEN_COMMAND_NAMES).not.toContain(token)
  }
}

describe('agent-desktop argv construction', () => {
  it('emits exactly the launch contract Main owns', () => {
    const plan = buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: 'TextEdit' }, scope)
    expect(plan.argv).toEqual([
      'launch',
      'TextEdit',
      '--session',
      'ola-sessiondigest',
      '--agent-id',
      'ola-main',
      '--timeout',
      '15000'
    ])
    expect(plan.env).toEqual({ AGENT_DESKTOP_HOME: '/abs/root' })
    expect(plan.timeoutMs).toBe(20_000)
  })

  it('never emits a forbidden surface for any model-shaped input', () => {
    const hostile = [
      '--headed',
      '--cdp',
      '--arg',
      '--env',
      '--force',
      '--include-bounds',
      '--activate',
      '',
      '   ',
      'a\nb',
      'a\tb',
      'a\x00b',
      '-x'.repeat(200),
      'TextEdit; rm -rf /',
      'agent-desktop'
    ]
    for (const app of hostile) {
      let plan: AgentDesktopPlan | null = null
      try {
        plan = buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app }, scope)
      } catch (error) {
        expect(error, `app=${JSON.stringify(app)}`).toBeInstanceOf(RuntimeError)
        continue
      }
      expect(plan.argv[0]).toBe('launch')
      assertNoForbidden(plan.argv)
    }
  })

  it('rejects empty, oversized and control-character app names locally', () => {
    expect(codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: '  ' }, scope))).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(
      codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: 'a'.repeat(201) }, scope))
    ).toBe('INVALID_TOOL_INPUT')
    expect(
      codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: 'a\n--headed' }, scope))
    ).toBe('INVALID_TOOL_INPUT')
    expect(codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, {}, scope))).toBe(
      'INVALID_TOOL_INPUT'
    )
  })

  it('clamps the CLI timeout into the bounded range', () => {
    const clamp = (timeoutMs: number): string =>
      timeoutArgOf(
        buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: 'TextEdit', timeoutMs }, scope).argv
      )
    expect(clamp(1)).toBe('1000')
    expect(clamp(4321)).toBe('4321')
    expect(clamp(999_999)).toBe('15000')
  })

  it('rejects a non-numeric timeout instead of coercing it', () => {
    expect(
      codeOf(() =>
        buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: 'TextEdit', timeoutMs: '1000' }, scope)
      )
    ).toBe('INVALID_TOOL_INPUT')
    expect(
      codeOf(() =>
        buildAgentDesktopPlan(DESKTOP_AX_LAUNCH_TOOL, { app: 'TextEdit', timeoutMs: NaN }, scope)
      )
    ).toBe('INVALID_TOOL_INPUT')
  })

  it('builds the observation verbs the CLI actually advertises', () => {
    const argv = (tool: AgentDesktopToolName, input: Record<string, unknown>): string[] =>
      buildAgentDesktopPlan(tool, input, scope).argv

    expect(argv(DESKTOP_AX_LIST_TOOL, { kind: 'windows', app: 'TextEdit' })).toEqual([
      'list-windows',
      '--app',
      'TextEdit',
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    expect(argv(DESKTOP_AX_LIST_TOOL, { kind: 'Apps' })).toEqual([
      'list-apps',
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    // `list-surfaces` declares no budget flag at all, so naming one is INVALID_ARGS at the CLI.
    expect(argv(DESKTOP_AX_LIST_TOOL, { kind: 'surfaces', app: 'TextEdit' })).toEqual([
      'list-surfaces',
      '--app',
      'TextEdit',
      ...tail
    ])
    expect(argv(DESKTOP_AX_SNAPSHOT_TOOL, { app: 'TextEdit' })).toEqual([
      'snapshot',
      '--app',
      'TextEdit',
      '--skeleton',
      '-i',
      '--compact',
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    expect(
      argv(DESKTOP_AX_SNAPSHOT_TOOL, {
        app: 'TextEdit',
        windowId: 'w-2',
        surface: 'sheet',
        waitFor: 'button:Save',
        timeoutMs: 4000
      })
    ).toEqual([
      'snapshot',
      '--app',
      'TextEdit',
      '--skeleton',
      '-i',
      '--compact',
      '--window-id',
      'w-2',
      '--surface',
      'sheet',
      '--wait-for',
      'button:Save',
      ...tail,
      '--timeout-ms',
      '4000',
      '--wait-timeout',
      '4000'
    ])
    expect(
      argv(DESKTOP_AX_INSPECT_TOOL, { app: 'TextEdit', role: 'button', name: 'Save' })
    ).toEqual([
      'find',
      '--app',
      'TextEdit',
      '--role',
      'button',
      '--name',
      'Save',
      '--limit',
      '10',
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    expect(
      argv(DESKTOP_AX_INSPECT_TOOL, {
        rootRef: '@s8f3k2p9:e12',
        text: 'OK',
        exact: true,
        limit: 99
      })
    ).toEqual([
      'find',
      '--root',
      '@s8f3k2p9:e12',
      '--text',
      'OK',
      '--exact',
      '--limit',
      '20',
      ...tail,
      '--timeout-ms',
      '15000'
    ])
  })

  it('builds the headless action verbs behind an option terminator', () => {
    const argv = (
      tool: AgentDesktopToolName,
      input: Record<string, unknown>,
      from = scope
    ): string[] => buildAgentDesktopPlan(tool, input, from).argv

    expect(argv(DESKTOP_AX_CLICK_TOOL, { ref: REF })).toEqual([
      'click',
      REF,
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    // Text is a positional value, so it travels after `--`: a string that starts with a dash must
    // not be re-read as one of the flags the plan builder just appended.
    expect(argv(DESKTOP_AX_INPUT_TEXT_TOOL, { ref: REF, text: '-5 % off' })).toEqual([
      'type',
      REF,
      ...tail,
      '--timeout-ms',
      '15000',
      '--',
      '-5 % off'
    ])
    // Windows has no semantic text insert, so the same tool writes the element value instead.
    expect(argv(DESKTOP_AX_INPUT_TEXT_TOOL, { ref: REF, text: 'hello' }, windowsScope)).toEqual([
      'set-value',
      REF,
      ...tail,
      '--timeout-ms',
      '15000',
      '--',
      'hello'
    ])
    expect(argv(DESKTOP_AX_ADJUST_TOOL, { ref: REF, action: 'toggle' })).toEqual([
      'toggle',
      REF,
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    expect(argv(DESKTOP_AX_ADJUST_TOOL, { ref: REF, action: 'scroll', direction: 'left' })).toEqual(
      ['scroll', REF, '--direction', 'left', '--amount', '3', ...tail, '--timeout-ms', '15000']
    )
    // Out-of-range scroll units clamp the way a timeout does; they are not a refusal.
    expect(argv(DESKTOP_AX_ADJUST_TOOL, { ref: REF, action: 'scroll', amount: 99 })).toEqual([
      'scroll',
      REF,
      '--amount',
      '10',
      ...tail,
      '--timeout-ms',
      '15000'
    ])
    expect(argv(DESKTOP_AX_ADJUST_TOOL, { ref: REF, action: 'select', value: 'Medium' })).toEqual([
      'select',
      REF,
      ...tail,
      '--timeout-ms',
      '15000',
      '--',
      'Medium'
    ])
  })

  it('raises the type budget to what the text itself needs', () => {
    const budget = (text: string, timeoutMs: number): string => {
      const argv = buildAgentDesktopPlan(
        DESKTOP_AX_INPUT_TEXT_TOOL,
        { ref: REF, text, timeoutMs },
        scope
      ).argv
      return argv[argv.indexOf('--timeout-ms') + 1]
    }
    // `type` documents its own default as 5000ms plus 30ms per character; a smaller explicit budget
    // would be a guaranteed TIMEOUT, so the floor wins.
    expect(budget('x'.repeat(100), 2000)).toBe('8000')
    expect(budget('x'.repeat(100), 15000)).toBe('15000')
    expect(budget('short', 1000)).toBe('5150')
    expect(budget('x'.repeat(320), 1000)).toBe('14600')
    // The character cap is what keeps that floor inside the ceiling the client timer is built on.
    expect(
      codeOf(() =>
        buildAgentDesktopPlan(
          DESKTOP_AX_INPUT_TEXT_TOOL,
          { ref: REF, text: 'x'.repeat(321) },
          scope
        )
      )
    ).toBe('INVALID_TOOL_INPUT')
    expect(
      codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_INPUT_TEXT_TOOL, { ref: REF, text: '' }, scope))
    ).toBe('INVALID_TOOL_INPUT')
  })

  it('refuses an action whose arguments cannot reach the verb it names', () => {
    const adjust = (input: Record<string, unknown>): string =>
      codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_ADJUST_TOOL, { ref: REF, ...input }, scope))

    expect(adjust({ action: 'toggle' })).toBe('NO_ERROR')
    expect(adjust({ action: 'toggle', value: 'ignored' })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'toggle', direction: 'up' })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'toggle', amount: 2 })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'scroll', value: 'ignored' })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'select' })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'press' })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'scroll', direction: 'sideways' })).toBe('INVALID_TOOL_INPUT')
    expect(adjust({ action: 'hover' })).toBe('INVALID_TOOL_INPUT')
  })

  it('requires a qualified ref on every action', () => {
    const shapes: Array<[AgentDesktopToolName, Record<string, unknown>]> = [
      [DESKTOP_AX_CLICK_TOOL, {}],
      [DESKTOP_AX_INPUT_TEXT_TOOL, { text: 'hello' }],
      [DESKTOP_AX_ADJUST_TOOL, { action: 'toggle' }]
    ]
    for (const [tool, extra] of shapes) {
      expect(
        codeOf(() => buildAgentDesktopPlan(tool, { ref: '@e5', ...extra }, scope)),
        tool
      ).toBe('INVALID_TOOL_INPUT')
      expect(
        codeOf(() =>
          buildAgentDesktopPlan(tool, { ref: '@s8f3k2p9:e5; rm -rf /', ...extra }, scope)
        ),
        tool
      ).toBe('INVALID_TOOL_INPUT')
      expect(
        codeOf(() => buildAgentDesktopPlan(tool, extra, scope)),
        tool
      ).toBe('INVALID_TOOL_INPUT')
      expect(
        codeOf(() => buildAgentDesktopPlan(tool, { ref: REF, ...extra }, scope)),
        tool
      ).toBe('NO_ERROR')
    }
  })

  it('never emits a forbidden surface for an action either', () => {
    const hostile = ['--headed', '--cdp', '--force', 'a\nb', 'a\tb', '   ', 'x'.repeat(400)]
    const shapes: Array<[AgentDesktopToolName, Record<string, unknown>]> = [
      [DESKTOP_AX_CLICK_TOOL, { app: 'TextEdit', ref: REF }],
      [DESKTOP_AX_INPUT_TEXT_TOOL, { app: 'TextEdit', ref: REF, text: 'hello' }],
      [
        DESKTOP_AX_ADJUST_TOOL,
        { app: 'TextEdit', ref: REF, action: 'scroll', direction: 'down', amount: 2 }
      ],
      [DESKTOP_AX_ADJUST_TOOL, { app: 'TextEdit', ref: REF, action: 'select', value: 'Medium' }]
    ]
    for (const [tool, base] of shapes) {
      for (const key of Object.keys(base)) {
        for (const value of hostile) {
          let plan: AgentDesktopPlan | null = null
          try {
            plan = buildAgentDesktopPlan(tool, { ...base, [key]: value }, scope)
          } catch (error) {
            expect(error, `${tool}.${key}=${JSON.stringify(value)}`).toBeInstanceOf(RuntimeError)
            continue
          }
          assertNoForbidden(plan.argv)
        }
      }
    }
  })

  it('names the timeout budget the way each verb spells it', () => {
    const launchArgv = buildAgentDesktopPlan(
      DESKTOP_AX_LAUNCH_TOOL,
      { app: 'TextEdit', timeoutMs: 7000 },
      scope
    ).argv
    expect(launchArgv).toContain('--timeout')
    expect(launchArgv).not.toContain('--timeout-ms')
    expect(budgetArgOf(DESKTOP_AX_LAUNCH_TOOL, launchArgv)).toBe('7000')

    const readTools: AgentDesktopToolName[] = [
      DESKTOP_AX_LIST_TOOL,
      DESKTOP_AX_SNAPSHOT_TOOL,
      DESKTOP_AX_INSPECT_TOOL
    ]
    for (const tool of readTools) {
      const argv = buildAgentDesktopPlan(
        tool,
        { app: 'TextEdit', kind: 'apps', role: 'button' },
        scope
      ).argv
      expect(argv, tool).not.toContain('--timeout')
      expect(argv, tool).toContain('--timeout-ms')
      expect(budgetArgOf(tool, argv), tool).toBe('15000')
    }
    // Budget flags are whitelisted per verb, so an unbudgeted verb gets no flag at all rather than
    // one the CLI rejects: the worst case becomes the CLI's own default, not a hard failure.
    const unbudgeted = buildAgentDesktopPlan(
      DESKTOP_AX_LIST_TOOL,
      { kind: 'surfaces', app: 'TextEdit' },
      scope
    ).argv
    expect(unbudgeted).not.toContain('--timeout')
    expect(unbudgeted).not.toContain('--timeout-ms')
    expect(unbudgeted).toContain('--session')
  })

  it('refuses a search that would turn into a full dump', () => {
    const inspect = (input: Record<string, unknown>): string =>
      codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_INSPECT_TOOL, input, scope))

    // No filter is a dump; no scope is a guess about which window to dump.
    expect(inspect({ app: 'TextEdit' })).toBe('INVALID_TOOL_INPUT')
    expect(inspect({ role: 'button' })).toBe('INVALID_TOOL_INPUT')
    expect(inspect({})).toBe('INVALID_TOOL_INPUT')
    // `--root` already fixes the scope and the CLI rejects the combination outright.
    expect(inspect({ rootRef: '@s8f3k2p9:e1', surface: 'menu', role: 'button' })).toBe(
      'INVALID_TOOL_INPUT'
    )
    expect(inspect({ app: 'TextEdit', role: 'button' })).toBe('NO_ERROR')
  })

  it('requires a qualified ref, because a bare one is a guaranteed round trip of INVALID_ARGS', () => {
    const ref = (rootRef: string): string =>
      codeOf(() =>
        buildAgentDesktopPlan(DESKTOP_AX_INSPECT_TOOL, { rootRef, role: 'button' }, scope)
      )
    expect(ref('@e12')).toBe('INVALID_TOOL_INPUT')
    expect(ref('s8f3k2p9:e12')).toBe('INVALID_TOOL_INPUT')
    expect(ref('@s8f3k2p9:e12')).toBe('NO_ERROR')
    expect(ref('@s8f3k2p9:e12; rm -rf /')).toBe('INVALID_TOOL_INPUT')
    expect(ref('@\u0000s8f3k2p9:e12')).toBe('INVALID_TOOL_INPUT')
  })

  it('closes the surface and inventory kind to the sets the CLI supports', () => {
    expect(
      codeOf(() =>
        buildAgentDesktopPlan(
          DESKTOP_AX_SNAPSHOT_TOOL,
          { app: 'TextEdit', surface: 'desktop2' },
          scope
        )
      )
    ).toBe('INVALID_TOOL_INPUT')
    expect(
      codeOf(() =>
        buildAgentDesktopPlan(DESKTOP_AX_SNAPSHOT_TOOL, { app: 'TextEdit', surface: 'menu' }, scope)
      )
    ).toBe('NO_ERROR')
    expect(
      codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_LIST_TOOL, { kind: 'processes' }, scope))
    ).toBe('INVALID_TOOL_INPUT')
    expect(codeOf(() => buildAgentDesktopPlan(DESKTOP_AX_LIST_TOOL, {}, scope))).toBe(
      'INVALID_TOOL_INPUT'
    )
  })

  it('never emits a forbidden surface from any read tool either', () => {
    const hostile = [
      '--headed',
      '--cdp',
      '--include-bounds',
      '--force',
      'a\nb',
      'a\tb',
      '   ',
      'x'.repeat(300)
    ]
    const shapes: Array<[AgentDesktopToolName, Record<string, unknown>]> = [
      [DESKTOP_AX_LIST_TOOL, { kind: 'apps', app: 'TextEdit' }],
      [
        DESKTOP_AX_SNAPSHOT_TOOL,
        { app: 'TextEdit', windowId: 'w-1', surface: 'sheet', waitFor: 'button:Save' }
      ],
      [
        DESKTOP_AX_INSPECT_TOOL,
        {
          app: 'TextEdit',
          rootRef: '@s8f3k2p9:e1',
          surface: 'menu',
          role: 'button',
          name: 'Save',
          text: 'ok'
        }
      ]
    ]
    for (const [tool, base] of shapes) {
      for (const key of Object.keys(base)) {
        for (const value of hostile) {
          let plan: AgentDesktopPlan | null = null
          try {
            plan = buildAgentDesktopPlan(tool, { ...base, [key]: value }, scope)
          } catch (error) {
            expect(error, `${tool}.${key}=${JSON.stringify(value)}`).toBeInstanceOf(RuntimeError)
            continue
          }
          assertNoForbidden(plan.argv)
        }
      }
    }
  })

  it('scopes one state root and session identity per run session', () => {
    const root = '/abs/.ola/agent-desktop'
    const first = agentDesktopSessionScope(root, 'ws-1', 'session-1')
    expect(first).toEqual(agentDesktopSessionScope(root, 'ws-1', 'session-1'))
    expect(first.home).toBe(join(root, first.session))
    expect(first.agentId).toBe('ola-main')
    expect(agentDesktopSessionScope(root, 'ws-1', 'session-2').session).not.toBe(first.session)
    expect(agentDesktopSessionScope(root, 'ws-2', 'session-1').session).not.toBe(first.session)
    // The null separator is what keeps ('ab','c') and ('a','bc') from sharing a namespace.
    expect(agentDesktopSessionScope(root, 'ab', 'c').session).not.toBe(
      agentDesktopSessionScope(root, 'a', 'bc').session
    )
  })

  it('gives a sub-agent its own agent id inside the same session namespace', () => {
    const parent = agentDesktopSessionScope('/abs', 'ws', 'session')
    const child = agentDesktopSessionScope('/abs', 'ws', 'session', 'subagent:explorer')
    expect(child.session).toBe(parent.session)
    expect(child.home).toBe(parent.home)
    expect(child.agentId).toMatch(/^ola-[0-9a-f]{12}$/)
    // The platform travels with the scope because it decides which verb a text write becomes.
    expect(child.platform).toBe(parent.platform)
    expect(agentDesktopSessionScope('/abs', 'ws', 'session', undefined, 'windows').platform).toBe(
      'windows'
    )
  })

  it('refuses a relative state root', () => {
    expect(codeOf(() => agentDesktopSessionScope('relative/path', 'ws', 'session'))).toBe(
      'INVALID_AGENT_DESKTOP_HOME'
    )
  })

  it('fails closed when a hand-built plan reintroduces a forbidden surface', () => {
    const allowedEnv = { AGENT_DESKTOP_HOME: '/abs/root' }
    expect(
      codeOf(() =>
        assertPlanIsAllowed({
          argv: ['launch', 'TextEdit', '--headed'],
          env: allowedEnv,
          timeoutMs: 1000
        })
      )
    ).toBe('AGENT_DESKTOP_FORBIDDEN_ARGUMENT')
    expect(
      codeOf(() => assertPlanIsAllowed({ argv: ['close-app'], env: allowedEnv, timeoutMs: 1000 }))
    ).toBe('AGENT_DESKTOP_FORBIDDEN_COMMAND')
    // Physical input is refused as a command, not only through the `--headed` flag that unlocks it.
    expect(
      codeOf(() => assertPlanIsAllowed({ argv: ['hover'], env: allowedEnv, timeoutMs: 1000 }))
    ).toBe('AGENT_DESKTOP_FORBIDDEN_COMMAND')
    expect(
      codeOf(() => assertPlanIsAllowed({ argv: ['batch'], env: allowedEnv, timeoutMs: 1000 }))
    ).toBe('AGENT_DESKTOP_FORBIDDEN_COMMAND')
    expect(
      codeOf(() =>
        assertPlanIsAllowed({
          argv: ['launch', 'TextEdit'],
          env: { AGENT_DESKTOP_HOME: 'not/absolute' },
          timeoutMs: 1000
        })
      )
    ).toBe('INVALID_AGENT_DESKTOP_HOME')
  })
})
