#!/usr/bin/env node
// Evidence recorder for docs/agent-desktop-acceptance.md. It drives the pinned agent-desktop CLI
// through the sequence a platform row claims to have covered and prints a paste-ready block.
//
// Screen content is never printed: a snapshot can name files, contacts and messages, so the record
// carries counts, lengths, flags and error codes only.
//
// Nothing here mutates a desktop by default. An action needs --allow-action and --action, plus
// --ref (a qualified ref, or `auto` to aim at the first element of the verb's own role), because an
// acceptance run must not become a way to click something by accident.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { release as osRelease, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectSnapshot } from '../src/main/agent-desktop/snapshot-shrink.ts'
import { agentDesktopPlatformKey, readAgentDesktopLock } from './stage-agent-desktop.mjs'

const DEFAULT_APP = { darwin: 'TextEdit', win32: 'Notepad', linux: 'Gnome Calculator' }
const AGENT_ID = 'ola-acceptance'
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_EMITTED_REFS = 12
// Mirrors `QUALIFIED_REF` in src/main/agent-desktop/args.ts. A bare `@e1` cannot resolve, and this
// script must not spend a real action on the user's screen to learn that.
const QUALIFIED_REF = /^@[A-Za-z0-9_-]{1,40}:e[0-9]{1,9}$/

export function parseArgs(argv) {
  const out = {
    action: null,
    ref: null,
    text: null,
    app: null,
    allowAction: false,
    emitRefs: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (entry === '--allow-action') out.allowAction = true
    else if (entry === '--emit-refs') out.emitRefs = true
    else if (entry === '--action') out.action = argv[++index] ?? null
    else if (entry === '--ref') out.ref = argv[++index] ?? null
    else if (entry === '--text') out.text = argv[++index] ?? null
    else if (entry === '--app') out.app = argv[++index] ?? null
  }
  return out
}

/**
 * The step that prints the block is the step that puts it in the repository, and `--text` appears in
 * the echoed argv, so a typed value has to be provably synthetic before anything is spawned.
 */
export function sentinelIsSafe(text) {
  return typeof text === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(text)
}

// Role names are the CLI's own vocabulary, not the OS's: one verb can be spelled differently per
// platform, so `auto` walks an ordered candidate list and takes the first role that matches anything.
const REF_ROLES = {
  click: { darwin: ['button'], win32: ['button'], linux: ['push button'] },
  type: {
    darwin: ['textfield', 'textarea', 'searchfield'],
    win32: ['edit'],
    linux: ['text', 'entry']
  },
  'set-value': { darwin: ['textfield', 'slider'], win32: ['edit'], linux: ['text'] },
  select: { darwin: ['combobox', 'listbox'], win32: ['combobox'], linux: ['combo box'] },
  toggle: { darwin: ['checkbox', 'switch'], win32: ['checkbox'], linux: ['check box'] },
  check: { darwin: ['checkbox', 'switch'], win32: ['checkbox'], linux: ['check box'] },
  uncheck: { darwin: ['checkbox', 'switch'], win32: ['checkbox'], linux: ['check box'] },
  expand: {
    darwin: ['disclosure triangle', 'outline row'],
    win32: ['button'],
    linux: ['panel']
  },
  collapse: {
    darwin: ['disclosure triangle', 'outline row'],
    win32: ['button'],
    linux: ['panel']
  },
  scroll: { darwin: ['scrollarea'], win32: ['pane'], linux: ['scroll pane'] }
}

export function refRoleCandidates(verb, platform) {
  const byPlatform = REF_ROLES[verb]
  if (!byPlatform) return []
  return byPlatform[platform] ?? []
}

/**
 * The verbs this recorder may spawn, and nothing else. `--action` reaches the CLI as a bare command
 * name, so without this list an acceptance run would be a way to type `close-app`, `press`,
 * `screenshot` or `clipboard-get` into a real desktop; the same list also drives role aiming, so a
 * verb with no roles is not an accident.
 */
export function actionVerbIsAllowed(verb) {
  return typeof verb === 'string' && Object.prototype.hasOwnProperty.call(REF_ROLES, verb)
}

/** The first match whose ref is actually addressable; a match with a bare ref is not a candidate. */
export function pickAutoRef(matches) {
  if (!Array.isArray(matches)) return null
  for (const match of matches) {
    const ref = match && typeof match === 'object' ? match.ref_id : null
    if (typeof ref === 'string' && QUALIFIED_REF.test(ref)) return ref
  }
  return null
}

/**
 * Refs and roles are minted identifiers and control vocabulary, not application text, so they are the
 * only part of a snapshot this recorder may print. `name`, `value` and `title` never leave the tree.
 */
export function collectRefs(payload, cap = MAX_EMITTED_REFS) {
  const found = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const ref = node.ref_id ?? node.ref
    if (typeof ref === 'string' && QUALIFIED_REF.test(ref)) {
      const role = typeof node.role === 'string' ? node.role.slice(0, 24) : ''
      found.push(role ? `${ref} (${role})` : ref)
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value)
    }
  }
  walk(payload)
  const unique = [...new Set(found)]
  return { refs: unique.slice(0, cap), total: unique.length }
}

/**
 * `find` answers with the roles that exist in the searched tree when it matches nothing. That is
 * control vocabulary rather than screen content, and it is what turns a failed `auto` aim into a
 * one-line fix instead of a guess.
 */
export function collectRoles(payload, cap = 24) {
  const found = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      // Only `roles_present` is read as strings below; a bare string anywhere else is application
      // vocabulary we do not own, so an array of them is not walked into the roles line.
      for (const item of node) {
        if (item && typeof item === 'object') walk(item)
      }
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'roles_present' && Array.isArray(value)) {
        for (const role of value) if (typeof role === 'string') found.add(role.slice(0, 24))
      } else if (value && typeof value === 'object') {
        walk(value)
      }
    }
  }
  walk(payload)
  return [...found].slice(0, cap)
}

export function formatRefSection({ refs, total, roles = [] }) {
  const lines = []
  if (total === 0) lines.push('refs: none minted this run')
  else {
    lines.push(`refs (${String(total)} minted, ${String(refs.length)} shown):`)
    for (const ref of refs) lines.push(`  ${ref}`)
    if (total > refs.length) lines.push(`  … ${String(total - refs.length)} more`)
  }
  if (roles.length) lines.push(`roles present: ${roles.join(', ')}`)
  return lines
}

export function rowIdForAction(platform, verb) {
  return platform === 'win32' && verb === 'set-value'
    ? 'windows-text-input'
    : 'action-delivery (note)'
}

function cliNameFor(platformKey) {
  return platformKey.startsWith('win32') ? 'agent-desktop.exe' : 'agent-desktop'
}

/**
 * Assemble one action's argv. The `--` escape has to stay last: everything after it is a positional,
 * so a flag appended afterwards would become a third argument and the CLI would answer INVALID_ARGS.
 * The full argv is what the evidence block echoes, so nothing may be added to it after this point.
 */
export function actionArgv({ verb, ref, scope, text }) {
  const base = [verb, ref, ...scope, '--timeout-ms', '8000']
  return text === null ? base : [...base, '--', text]
}

/** One CLI call with its envelope parsed. A non-zero exit is a result, not an exception. */
function call(binary, argv, home, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      binary,
      argv,
      {
        env: { ...process.env, AGENT_DESKTOP_HOME: home },
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, stdout) => {
        let envelope = null
        try {
          envelope = JSON.parse(String(stdout))
        } catch {
          envelope = null
        }
        resolve({
          command: argv.join(' '),
          ok: Boolean(envelope?.ok),
          code: envelope?.error?.code ?? (error?.code === 'ENOENT' ? 'BINARY_MISSING' : null),
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          data: envelope?.data ?? {},
          // A refused action reports its disposition under `error`, a delivered one under `data`; the
          // row needs whichever one exists, because refusing without saying so is the thing P3 maps.
          disposition: envelope?.data?.disposition ?? envelope?.error?.disposition ?? {},
          chars: String(stdout ?? '').length
        })
      }
    )
  })
}

function evidenceBlock(meta, steps, rows, refs) {
  const lines = [
    '```text',
    `agent-desktop acceptance — ${meta.platform}`,
    `os build: ${meta.osBuild}`,
    `triple: ${meta.triple}   backend: ${meta.backend}   cli: ${meta.cli}`,
    `accessibility: ${meta.accessibility}   session: ${meta.session}`,
    '',
    'steps (no screen content is recorded):'
  ]
  for (const step of steps) {
    lines.push(`  $ agent-desktop ${step.command}`)
    lines.push(
      `    ok=${step.ok} code=${step.code ?? 'none'} exit=${step.exitCode} chars=${step.chars}`
    )
  }
  if (refs) {
    lines.push('')
    lines.push(...refs)
  }
  lines.push('', 'rows — replace pending with pass or fail by hand, after reading the steps:')
  for (const row of rows) lines.push(`  ${row.id}: ${row.status} — ${row.evidence}`)
  lines.push('```')
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.text !== null && !sentinelIsSafe(options.text)) {
    console.error(
      '--text lands in the paste-ready evidence block, so it has to be a synthetic sentinel: letters, digits, space, dot, underscore or dash, at most 40 characters.'
    )
    return 2
  }
  if (options.action && !actionVerbIsAllowed(options.action)) {
    console.error(
      `--action "${options.action}" is not one of the semantic verbs this recorder accepts (${Object.keys(REF_ROLES).join(', ')}); nothing was spawned.`
    )
    return 2
  }
  if (options.allowAction && !options.action) {
    console.error('--allow-action needs --action, otherwise there is nothing to run.')
    return 2
  }
  const platformKey = agentDesktopPlatformKey()
  const binary = join(
    process.cwd(),
    'resources',
    'agent-desktop',
    platformKey,
    cliNameFor(platformKey)
  )
  const lock = await readAgentDesktopLock()
  if (!lock.platforms[platformKey]) {
    console.error(`The lock pins no archive for ${platformKey}; this platform cannot be accepted.`)
    return 2
  }

  const meta = {
    platform: `${process.platform} ${process.arch} / node ${process.version}`,
    osBuild: osRelease(),
    triple: platformKey,
    backend: 'unknown',
    cli: lock.version,
    accessibility: 'unknown',
    session: `ola-accept-${Date.now()}`
  }
  const scope = ['--session', meta.session, '--agent-id', AGENT_ID]
  const app = options.app ?? DEFAULT_APP[process.platform] ?? DEFAULT_APP.linux
  const suiteRow = {
    darwin: 'macos-accessibility-suite',
    win32: 'windows-uia-suite',
    linux: 'linux-x11-suite'
  }[process.platform]
  const home = mkdtempSync(join(tmpdir(), 'ola-agent-desktop-accept-'))
  const steps = []
  const rows = []

  try {
    const status = await call(binary, ['status', ...scope], home, 20_000)
    steps.push(status)
    meta.backend = String(status.data.platform ?? status.data.backend ?? platformKey.split('-')[0])
    meta.cli = String(status.data.version ?? lock.version)
    meta.accessibility = String(status.data.permissions?.accessibility?.state ?? 'unknown')

    if (status.code === 'BINARY_MISSING') {
      console.error(`${binary} is not the pinned build. Run npm run fetch:agent-desktop first.`)
      return 2
    }

    rows.push({
      id: 'session-facts',
      status: 'info',
      evidence: `XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE ?? 'unset'} WAYLAND_DISPLAY=${
        process.env.WAYLAND_DISPLAY ?? 'unset'
      } DISPLAY=${process.env.DISPLAY ?? 'unset'}; supported_surfaces=${JSON.stringify(
        status.data.supported_surfaces ?? []
      )}`
    })

    if (!status.ok || meta.accessibility !== 'granted') {
      rows.push({
        id: suiteRow,
        status: 'fail',
        evidence: `Accessibility is ${meta.accessibility}, so nothing can be observed. macOS attributes the grant to the app that owns this shell process, not to the CLI and not to a packaged Ola.app; grant it in System Settings → Privacy & Security → Accessibility and reopen the shell. Ola never prompts for it from a tool call.`
      })
      console.log(evidenceBlock(meta, steps, rows))
      return 1
    }

    const launch = await call(binary, ['launch', app, ...scope, '--timeout', '20000'], home, 25_000)
    steps.push(launch)
    const snapshot = await call(
      binary,
      [
        'snapshot',
        '--app',
        app,
        ...scope,
        '--skeleton',
        '-i',
        '--compact',
        '--timeout-ms',
        '15000'
      ],
      home,
      20_000
    )
    steps.push(snapshot)
    const find = await call(
      binary,
      ['find', '--app', app, ...scope, '--role', 'button', '--limit', '3', '--timeout-ms', '8000'],
      home,
      12_000
    )
    steps.push(find)

    const refCount = snapshot.data.ref_count ?? 0
    // A search that finds nothing still proves the tree was walkable and answerable: `find` reports
    // NO_MATCHES rather than an error, so an empty-but-successful search is a review, not a failure.
    const searched = find.ok || find.code === 'NO_MATCHES'
    // `launch` returns once the process runs, not once it has a window, and forcing a window needs
    // `--activate`, which is a red line here. Naming that split is part of what the row must record.
    const noWindow = !snapshot.ok && snapshot.code === 'WINDOW_NOT_FOUND'
    rows.push({
      id: suiteRow,
      status: launch.ok && snapshot.ok && searched ? 'review' : 'fail',
      evidence: `launch+snapshot+find on ${app}; refs minted=${String(refCount)}; matches=${String(
        (find.data.matches ?? []).length
      )}${find.ok ? '' : ` find=${find.code ?? 'error'}`} roles_present=[${collectRoles(find.data).join(', ')}]${
        noWindow
          ? '; WINDOW_NOT_FOUND after a successful launch means the process runs with no window, which this recorder may not force (`--activate` is a red line) — give the app a window and re-run'
          : ''
      }`
    })
    // The row claims the shrinker is calibrated against real CLI output, which only the rendered
    // outline can show: the raw envelope size says nothing about what the model would actually get.
    const rendered = snapshot.ok ? inspectSnapshot(snapshot.data) : null
    rows.push({
      id: process.platform === 'darwin' ? 'macos-snapshot-budget' : 'snapshot-budget (note)',
      status: rendered ? 'review' : 'fail',
      evidence: `raw envelope ${snapshot.chars} chars for a --skeleton -i read; complete=${String(
        snapshot.data.complete
      )} truncated=${String(snapshot.data.truncated)} nodes_observed=${String(
        snapshot.data.nodes_observed
      )}${
        rendered
          ? `; rendered=${String(rendered.chars)}/${String(7800)} hidden=${String(
              rendered.hidden
            )} markers=${String(rendered.markers)} drill=${String(rendered.drillHint)}`
          : '; the snapshot did not render, so the budget is unmeasured'
      }`
    })
    if (process.platform === 'linux') {
      const waylandOnly = Boolean(process.env.WAYLAND_DISPLAY) && !process.env.DISPLAY
      rows.push({
        id: 'linux-wayland-refusal',
        status: waylandOnly ? (status.ok ? 'fail' : 'review') : 'not-this-session',
        evidence: waylandOnly
          ? `Wayland-only session: status ok=${status.ok} code=${status.code ?? 'none'}. A refusal is the pass condition.`
          : 're-run on a Wayland-only session to close this row'
      })
    }

    // An action needs a ref the redacted block never prints, so `auto` aims at the first element of
    // the verb's own role instead of making the operator read screen content to find one.
    let actionRef = null
    if (options.ref && options.ref !== 'auto') {
      if (QUALIFIED_REF.test(options.ref)) actionRef = options.ref
      else
        console.error(
          `--ref "${options.ref}" is not a qualified @<snapshot>:eN ref, so no action was attempted.`
        )
    }
    const autoRoles =
      options.ref === 'auto' ? refRoleCandidates(options.action ?? '', process.platform) : []
    const rolesTried = []
    const probeData = []
    if (!actionRef && autoRoles.length) {
      for (const role of autoRoles) {
        rolesTried.push(role)
        const probe = await call(
          binary,
          ['find', '--app', app, ...scope, '--role', role, '--limit', '1', '--timeout-ms', '8000'],
          home,
          12_000
        )
        steps.push(probe)
        probeData.push(probe.data)
        actionRef = pickAutoRef(probe.data.matches)
        if (actionRef) break
      }
    }

    if (options.allowAction && options.action && actionRef) {
      const action = await call(
        binary,
        actionArgv({ verb: options.action, ref: actionRef, scope, text: options.text }),
        home,
        12_000
      )
      steps.push(action)
      // Searching for the sentinel is the only way to turn `delivered_unverified` into an observed
      // fact, and `--count` answers with a number instead of the text found on screen. `--count`
      // cannot be combined with `--limit`, so the probe sends no limit.
      const verification =
        action.ok && options.text !== null
          ? await call(
              binary,
              [
                'find',
                '--app',
                app,
                ...scope,
                '--text',
                options.text,
                '--count',
                '--timeout-ms',
                '8000'
              ],
              home,
              12_000
            )
          : null
      if (verification) steps.push(verification)
      const disposition = action.disposition
      // `--count` answers with `{count}`; a search that matches nothing answers NO_MATCHES, which is a
      // zero rather than a broken probe, so it must not read as unknown.
      const found = verification
        ? (verification.data.count ?? (verification.code === 'NO_MATCHES' ? 0 : 'unknown'))
        : null
      rows.push({
        id: rowIdForAction(process.platform, options.action),
        status: action.ok ? 'review' : 'fail',
        evidence: `${options.action} on ${actionRef}: delivery=${
          disposition.delivery ?? 'absent'
        } retry=${disposition.retry ?? 'absent'} code=${action.code ?? 'none'}${
          found === null
            ? ''
            : ` sentinel_found=${String(found)} (find --count ok=${verification.ok} exit=${
                verification.exitCode
              })`
        }`
      })
    } else if (options.action && !options.allowAction) {
      console.error('--action needs --allow-action, so no action was attempted.')
    } else if (options.action && options.allowAction) {
      rows.push({
        id: rowIdForAction(process.platform, options.action),
        status: 'not-exercised',
        evidence: `--ref auto found no ${options.action} target in ${app}${
          rolesTried.length ? ` (roles tried: ${rolesTried.join(', ')})` : ''
        }; roles actually present=[${collectRoles(probeData).join(', ')}]. Re-run with --ref <that ref> from --emit-refs, or aim another app.`
      })
    } else if (process.platform === 'win32') {
      rows.push({
        id: 'windows-text-input',
        status: 'not-exercised',
        evidence: 're-run with --allow-action --action set-value --ref auto --text <sentinel>'
      })
      rows.push({
        id: 'windows-twin-ref',
        status: 'not-exercised',
        evidence:
          'press the same control through two sibling refs, or name where AMBIGUOUS_TARGET appeared'
      })
    }

    // `auto` can still miss (a window with no element of the verb's role), and a human aiming the next
    // run needs a ref without reading the tree: refs and roles are minted ids and control vocabulary.
    const refSection = options.emitRefs
      ? formatRefSection({
          ...collectRefs({ tree: snapshot.data.tree, matches: find.data.matches }),
          roles: collectRoles({ find: find.data, probes: probeData })
        })
      : null
    console.log(evidenceBlock(meta, steps, rows, refSection))
    return rows.some((row) => row.status === 'fail') ? 1 : 0
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// Guarded so the pure rules above stay importable by tests/runtime/agent-desktop-acceptance.test.ts,
// which must never launch the real binary at a real desktop.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main())
}
