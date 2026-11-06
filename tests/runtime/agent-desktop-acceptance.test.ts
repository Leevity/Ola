import { describe, expect, it } from 'vitest'
import {
  actionArgv,
  actionVerbIsAllowed,
  collectRefs,
  collectRoles,
  formatRefSection,
  parseArgs,
  pickAutoRef,
  refRoleCandidates,
  rowIdForAction,
  sentinelIsSafe
} from '../../scripts/agent-desktop-acceptance.mjs'

const QUALIFIED = '@s8f3k2p9:e1'
// The recorder prints a paste-ready block that lands in the repository, so anything it reads out of
// `name`/`value`/`title` would be published with it. Planting a marker here proves it never is.
const SCREEN_SECRET = 'PasswordHunter9000'

const node = (ref: string, role: string) => ({
  ref_id: ref,
  role,
  name: SCREEN_SECRET,
  value: SCREEN_SECRET,
  title: SCREEN_SECRET,
  states: [SCREEN_SECRET]
})

describe('agent-desktop acceptance recorder', () => {
  it('parses the flags the runbook uses and defaults the rest to off', () => {
    expect(parseArgs([])).toEqual({
      action: null,
      ref: null,
      text: null,
      app: null,
      allowAction: false,
      emitRefs: false
    })
    expect(
      parseArgs([
        '--allow-action',
        '--action',
        'type',
        '--ref',
        'auto',
        '--emit-refs',
        '--text',
        'ola-ax-accept-1',
        '--app',
        'System Settings'
      ])
    ).toEqual({
      action: 'type',
      ref: 'auto',
      text: 'ola-ax-accept-1',
      app: 'System Settings',
      allowAction: true,
      emitRefs: true
    })
    // A flag at the end of argv with no value must not swallow undefined into a truthy field.
    expect(parseArgs(['--action']).action).toBeNull()
  })

  it('only lets a provably synthetic sentinel reach the evidence block', () => {
    expect(sentinelIsSafe('ola-ax-accept-1')).toBe(true)
    expect(sentinelIsSafe('ola ax accept 1.0_2-3')).toBe(true)
    for (const rejected of [
      'line\nbreak',
      'quote"s',
      "quote's",
      '@s8f3k2p9:e1',
      'x'.repeat(41),
      '输入法',
      'emoji 🎯',
      '',
      'back\\slash',
      'slash/a',
      'dollar$value',
      42,
      null,
      undefined
    ]) {
      expect(sentinelIsSafe(rejected as string)).toBe(false)
    }
  })

  it('gives every verb a role list per platform and nothing for names it does not know', () => {
    const verbs = [
      'click',
      'type',
      'set-value',
      'select',
      'toggle',
      'check',
      'uncheck',
      'expand',
      'collapse',
      'scroll'
    ]
    for (const verb of verbs) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const candidates = refRoleCandidates(verb, platform)
        expect(candidates.length, `${verb} on ${platform}`).toBeGreaterThan(0)
        expect(candidates.every((role) => typeof role === 'string' && role.length > 0)).toBe(true)
      }
    }
    expect(refRoleCandidates('close-app', 'darwin')).toEqual([])
    expect(refRoleCandidates('click', 'freebsd')).toEqual([])
    expect(refRoleCandidates('', 'darwin')).toEqual([])
    // macOS AX roles are lowercase short names; AT-SPI names the Linux roles it spells differently.
    expect(refRoleCandidates('click', 'darwin')).toEqual(['button'])
    expect(refRoleCandidates('click', 'linux')).toEqual(['push button'])
    expect(refRoleCandidates('type', 'darwin')).toEqual(['textfield', 'textarea', 'searchfield'])
    expect(refRoleCandidates('type', 'win32')).toEqual(['edit'])
    expect(refRoleCandidates('set-value', 'darwin')).toEqual(['textfield', 'slider'])
  })

  it('takes the first addressable ref and refuses one that cannot resolve', () => {
    expect(pickAutoRef([node('@s8f3k2p9:e7', 'button'), node('@s8f3k2p9:e2', 'button')])).toBe(
      '@s8f3k2p9:e7'
    )
    // A bare ref survives parsing but fails inside the CLI, so it must not cost an action on screen.
    expect(pickAutoRef([{ ref_id: '@e1', role: 'button' }, node(QUALIFIED, 'button')])).toBe(
      QUALIFIED
    )
    expect(pickAutoRef([{ ref_id: '@e1', role: 'button' }])).toBeNull()
    expect(pickAutoRef([{ role: 'button' }, null, 'text', 7])).toBeNull()
    expect(pickAutoRef([])).toBeNull()
    expect(pickAutoRef(undefined)).toBeNull()
    expect(pickAutoRef('nope')).toBeNull()
  })

  it('emits minted refs and roles only, capped and de-duplicated', () => {
    const payload = {
      tree: {
        role: 'window',
        name: SCREEN_SECRET,
        children: [
          node(QUALIFIED, 'button'),
          node('@s8f3k2p9:e2', 'textfield'),
          { ref: '@s8f3k2p9:e3', role: 'group' }
        ]
      },
      matches: [
        { ref_id: QUALIFIED, role: 'button' },
        { ref_id: '@s8f3k2p9:e9', role: 'x'.repeat(80) }
      ]
    }
    const first = collectRefs(payload)
    expect(first.refs).toEqual([
      `${QUALIFIED} (button)`,
      '@s8f3k2p9:e2 (textfield)',
      '@s8f3k2p9:e3 (group)',
      '@s8f3k2p9:e9 (' + 'x'.repeat(24) + ')'
    ])
    expect(first.total).toBe(4)
    expect(JSON.stringify(first.refs)).not.toContain(SCREEN_SECRET)

    const many = Array.from({ length: 30 }, (_, index) => `@s8f3k2p9:e${index + 1}`).map((ref) => ({
      ref_id: ref
    }))
    const capped = collectRefs({ items: many })
    expect(capped.refs).toHaveLength(12)
    expect(capped.total).toBe(30)
    expect(collectRefs({ items: many }, 3).refs).toHaveLength(3)
    expect(collectRefs({}).total).toBe(0)
  })

  it('formats the ref section so a capped list still says how much is missing', () => {
    expect(formatRefSection({ refs: [], total: 0 })).toEqual(['refs: none minted this run'])
    expect(formatRefSection({ refs: [], total: 0, roles: ['window', 'button'] })).toEqual([
      'refs: none minted this run',
      'roles present: window, button'
    ])
    const two = collectRefs({ tree: node(QUALIFIED, 'button') })
    expect(formatRefSection(two)).toEqual(['refs (1 minted, 1 shown):', `  ${QUALIFIED} (button)`])
    const capped = collectRefs({
      items: Array.from({ length: 14 }, (_, index) => ({ ref_id: `@s8f3k2p9:e${index}` }))
    })
    const section = formatRefSection(capped)
    expect(section[0]).toBe('refs (14 minted, 12 shown):')
    expect(section[section.length - 1]).toBe('  … 2 more')
    expect(section).toHaveLength(14)
    const withRoles = formatRefSection({ ...capped, roles: ['button'] })
    expect(withRoles[withRoles.length - 1]).toBe('roles present: button')
    expect(withRoles).toHaveLength(15)
  })

  it('only spawns verbs that are semantic and aimed', () => {
    for (const verb of [
      'click',
      'type',
      'set-value',
      'select',
      'toggle',
      'check',
      'uncheck',
      'expand',
      'collapse',
      'scroll'
    ]) {
      expect(actionVerbIsAllowed(verb), verb).toBe(true)
    }
    // Everything on this list is either physical input, an unredacted surface, or teardown the
    // operator has to do by hand; the CLI would accept them, this recorder must not.
    for (const rejected of [
      'close-app',
      'quit',
      'kill',
      'press',
      'key-down',
      'hover',
      'drag',
      'double-click',
      'triple-click',
      'right-click',
      'scroll-to',
      'clear',
      'focus',
      'screenshot',
      'clipboard-get',
      'notification-action',
      'open-system-surface',
      'mcp',
      'batch',
      'permissions',
      '--headed',
      '',
      undefined
    ]) {
      expect(actionVerbIsAllowed(rejected as string), String(rejected)).toBe(false)
    }
  })

  it('reads the role vocabulary a failed search reports, and nothing else', () => {
    expect(
      collectRoles({
        matches: [],
        roles_present: ['window', 'group', 'button', 'textfield'],
        total_count: 0
      })
    ).toEqual(['window', 'group', 'button', 'textfield'])
    expect(
      collectRoles([{ roles_present: ['button'] }, { roles_present: ['button', 'slider'] }])
    ).toEqual(['button', 'slider'])
    // A value the application chose is not a role: only the roles_present arrays are read.
    expect(
      collectRoles({
        matches: [{ name: SCREEN_SECRET, value: SCREEN_SECRET, states: [SCREEN_SECRET] }],
        text: [SCREEN_SECRET]
      })
    ).toEqual([])
    expect(collectRoles({})).toEqual([])
    expect(collectRoles(undefined)).toEqual([])
    const many = collectRoles({
      roles_present: Array.from({ length: 40 }, (_, i) => `role-${String(i)}`)
    })
    expect(many).toHaveLength(24)
    expect(collectRoles({ roles_present: ['x'.repeat(80)] })[0]).toHaveLength(24)
  })

  it('assembles an action argv that ends with the value it types', () => {
    const scope = ['--session', 'ola-accept-1', '--agent-id', 'ola-acceptance']
    expect(actionArgv({ verb: 'click', ref: QUALIFIED, scope, text: null })).toEqual([
      'click',
      QUALIFIED,
      ...scope,
      '--timeout-ms',
      '8000'
    ])
    const typed = actionArgv({ verb: 'type', ref: QUALIFIED, scope, text: 'ola-ax-accept-1' })
    expect(typed.slice(-2)).toEqual(['--', 'ola-ax-accept-1'])
    // Everything after `--` is a positional, so a flag appended here became a third argument and the
    // CLI answered INVALID_ARGS instead of typing.
    expect(typed.indexOf('--')).toBe(typed.length - 2)
    expect(typed.slice(0, typed.indexOf('--'))).toContain('--agent-id')
  })

  it('maps an action back to the row it can close', () => {
    expect(rowIdForAction('win32', 'set-value')).toBe('windows-text-input')
    // Any other platform/verb pair is a note, not a table row: the gate fails unknown row ids.
    expect(rowIdForAction('darwin', 'type')).toBe('action-delivery (note)')
    expect(rowIdForAction('darwin', 'set-value')).toBe('action-delivery (note)')
    expect(rowIdForAction('linux', 'click')).toBe('action-delivery (note)')
  })
})
