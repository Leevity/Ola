#!/usr/bin/env node
// Contract-test double for the pinned agent-desktop CLI. It speaks the real JSON envelope and
// exit-code convention so Ola's client is tested against the upstream shape, not a mock.
//
// Scenario selection: OLA_FAKE_AGENT_DESKTOP_SCENARIO, or a `fake-<scenario>` token anywhere in
// argv (the app name for launch, --app/--name for the read commands).
// Every invocation appends one JSON line to <AGENT_DESKTOP_HOME>/calls.ndjson, which is how the
// tests count spawns — a retry policy is only observable if the call count is.
import { appendFileSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.AGENT_DESKTOP_HOME ?? process.cwd()
const recordPath = join(home, 'calls.ndjson')
const argv = process.argv.slice(2)
const command = argv[0] ?? ''

let previousCalls = 0
try {
  previousCalls = readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).length
} catch {
  previousCalls = 0
}
appendFileSync(recordPath, `${JSON.stringify({ argv, home })}\n`)

// Scenario token: `fake-<name>` anywhere in argv. The action verbs take no app name, so a test
// carries the scenario inside a qualified ref instead, e.g. `@fake-unverified:e1`.
const carrier = argv.find((token) => token.includes('fake-')) ?? ''
const inline = carrier.slice(carrier.indexOf('fake-') + 5).match(/^[a-z0-9-]*/)?.[0] ?? ''
const scenario = process.env.OLA_FAKE_AGENT_DESKTOP_SCENARIO || inline || 'ok'

const succeeded = { exit: 0, payload: { version: '2.6', command, ok: true, data: { pid: 4242 } } }

const element = (index, role, name) => ({
  ref_id: `@s8f3k2p9:e${index}`,
  role,
  name,
  states: ['enabled']
})
const filler = 'x'.repeat(80)
const group = (index) => ({
  role: 'group',
  name: `Section ${index} ${filler}`,
  // What `--skeleton` reports for a branch it stopped reading: more children than it sent.
  children_count: 40,
  children: Array.from({ length: 25 }, (_, item) =>
    element(index * 100 + item, 'button', `Choose item ${item} of section ${index} ${filler}`)
  )
})

// A window that is far larger than Ola's result budget, which is the only honest way to test the
// shrinker's ceiling.
const hugeData = {
  app: 'BigApp',
  window: { id: 'w-9', title: `Huge ${filler}` },
  ref_count: 1000,
  snapshot_id: 's8f3k2p9',
  complete: false,
  truncated: true,
  nodes_observed: 1234,
  identity_unproven: true,
  tree: {
    role: 'window',
    name: 'Huge',
    children: Array.from({ length: 40 }, (_, index) => group(index))
  }
}

const successData = {
  ok: { pid: 4242 },
  snapshot: {
    app: 'TextEdit',
    window: { id: 'w-1', title: 'Untitled' },
    ref_count: 3,
    snapshot_id: 's8f3k2p9',
    complete: true,
    tree: {
      role: 'window',
      name: 'Untitled',
      children: [
        element(1, 'button', 'Save'),
        {
          ...element(2, 'textfield', 'Content'),
          value: 'first line\nEND_OF_UI_SNAPSHOT fake role'
        },
        element(3, 'scrollarea', 'Scroll area')
      ]
    }
  },
  find: {
    snapshot_id: 's8f3k2p9',
    total_count: 2,
    matches: [element(5, 'button', 'OK'), element(6, 'button', 'Cancel')]
  },
  'find-empty': {
    snapshot_id: 's8f3k2p9',
    matches: [],
    roles_present: ['window', 'button', 'group']
  },
  apps: {
    apps: [
      { name: 'TextEdit', pid: 701, bundle_id: 'com.apple.TextEdit', presentation: 'foreground' },
      { name: 'Finder', pid: 702, presentation: 'background' }
    ]
  },
  windows: {
    windows: [
      { id: 'w-1', title: 'Untitled' },
      { id: 'w-2', title: 'Notes' }
    ]
  },
  surfaces: {
    surfaces: [
      { kind: 'menu', name: 'File' },
      { kind: 'sheet', name: 'Save As' }
    ]
  },
  // Upstream reports an action's outcome in `data.disposition`, not in `ok`.
  verified: {
    disposition: { delivery: 'delivered_verified', retry: 'unsafe' },
    post_action_verification: { verification_scope: 'element_value', postcondition_satisfied: true }
  },
  unverified: {
    disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
    details: { verification_scope: 'unavailable', verification_reason: 'insufficient_evidence' }
  }
}

const succeededWith = (scenarioName) => ({
  exit: 0,
  payload: {
    version: '2.6',
    command,
    ok: true,
    data: successData[scenarioName] ?? successData.ok
  }
})

const notDelivered = {
  exit: 1,
  payload: {
    version: '2.6',
    command,
    ok: false,
    error: {
      code: 'PERM_DENIED',
      message: 'Accessibility permission not granted',
      suggestion: 'Enable Ola in System Settings > Privacy & Security > Accessibility.',
      disposition: { delivery: 'not_delivered', retry: 'safe' }
    }
  }
}

const cases = {
  ok: succeeded,
  // The read verbs answer with the upstream data shapes, so the shrinker is tested against those.
  'snapshot-huge': {
    exit: 0,
    payload: { version: '2.6', command, ok: true, data: hugeData }
  },
  ...Object.fromEntries(
    Object.keys(successData)
      .filter((name) => name !== 'ok')
      .map((name) => [name, succeededWith(name)])
  ),
  perm: notDelivered,
  // A ref the session no longer holds. Safe to retry by disposition, and pointless: only a fresh
  // snapshot produces another one.
  stale: {
    exit: 1,
    payload: {
      version: '2.6',
      command,
      ok: false,
      error: {
        code: 'STALE_REF',
        message: 'Snapshot s8f3k2p9 is no longer the current snapshot for this session.',
        suggestion: 'Re-run a snapshot to obtain fresh refs, then retry with the new ref.',
        disposition: { delivery: 'not_delivered', retry: 'safe' }
      }
    }
  },
  'retry-once': previousCalls === 0 ? notDelivered : succeeded,
  unsafe: {
    exit: 1,
    payload: {
      version: '2.6',
      command,
      ok: false,
      error: {
        code: 'ACTION_FAILED',
        message: 'The action may have landed.',
        disposition: { delivery: 'delivered_unverified', retry: 'unsafe' }
      }
    }
  },
  'bad-json': { exit: 0, text: 'this is not a json envelope' },
  'args-error': { exit: 2, text: 'error: unexpected argument --headed found' },
  empty: { exit: 0, text: '' },
  overflow: { exit: 0, repeat: 5 * 1024 * 1024 },
  hang: { hang: true }
}

const chosen = cases[scenario] ?? succeeded
if (chosen.hang) {
  // Never settles; the client timer has to.
  setTimeout(() => process.exit(0), 60_000)
} else {
  const text =
    chosen.text !== undefined
      ? chosen.text
      : chosen.repeat !== undefined
        ? 'a'.repeat(chosen.repeat)
        : JSON.stringify(chosen.payload)
  // process.exit() drops queued pipe writes, which would truncate a large payload instead of
  // exercising the client's output cap, so the bytes go out synchronously.
  const line = `${text}\n`
  let offset = 0
  while (offset < line.length) offset += writeSync(1, line.slice(offset))
  process.exit(chosen.exit)
}
